# VA Admin Page Redesign — Design Spec

**Date:** 2026-05-07
**Status:** Approved
**Scope:** Phase 1 — UI redesign of `pages/admin.html` (GPs tab task workspace)
**Phase 2:** Bug fixes, AI note follow-ups, reconciliation cron, VA SOP, CEO doc

---

## Summary

Redesign the VA Command Centre GPs tab to group tasks by registration stage with guided next-action workflows, replace priority-based task grouping, add priority lanes to the GP list, and simplify the page structure. Goal: reduce VA training time by making every task self-explanatory and step-by-step.

---

## Design Decisions

### 1. Page Layout — Profile Bar + Journey Rail (Option C)

- **Left sidebar:** GP list with priority lanes
- **Main area:** Compact profile bar → journey rail → sub-tabs (Tasks | Notes) → stage-grouped tasks
- Profile bar shows: avatar, name, email, phone, stage badge, qualification count, WhatsApp/Nudge buttons, expand toggle (▾)
- Expand toggle reveals case management fields: assigned VA, case status, practice info, handover notes
- Journey rail: horizontal chevron progression (✓ Placement → ✓ MyIntealth → ✓ AMC → ● AHPRA → PBS → Commence)

### 2. Task Grouping — By Registration Stage

Tasks grouped under their `related_stage` instead of by priority:
- Active stage(s) shown with purple dot and full task cards
- Future locked stages shown dimmed with "unlocks after X" label
- Completed stages collapsed or hidden
- Priority still indicated via badges on task cards (red "urgent", amber "overdue")
- Fallback "Other" group for tasks with no `related_stage`

### 3. Guided Actions — Prominent Next Action + Dropdown (Option B)

Each task card shows:
- Task title
- Guided prompt: "→ Next: [specific instruction for current step]"
- One primary action button matching the current step
- ••• dropdown for other actions (status changes, emails, nudge, escalate, add note, set follow-up)
- Inline document display when attachment exists (filename, confidence score)

**Step logic determined by task state:**
- Document task: no attachment → "Email practice requesting doc" | attachment exists → "Review document" | reviewed → "Approve or Request revision"
- Verification task: evidence needed → "Review evidence" | reviewed → "Mark verified or Flag issue"
- Practice pack task: unsigned → "Send via Zoho Sign" | sent → "Awaiting signatures" | signed → "Upload to Drive"

### 4. GP List — Priority Lanes (Option C)

Left sidebar split into two zones:
- **Needs Action** (red dot): GPs with urgent/overdue/due-today tasks
- **On Track** (green dot): GPs with no immediate action needed
- Each GP card shows: avatar, name, current stage, task count, urgency indicators
- Search bar at top, filter chips available

### 5. Top Navigation — 4 Tabs (Option B)

- **GPs** (default) — main workspace with priority lanes + task view
- **Medical Centres** — unchanged
- **Support** — tickets + WhatsApp help (with notification dot)
- **Ops Queue** — renamed from "Tasks", cross-GP operational table view

### 6. GP Sub-Tabs — Tasks + Notes (Option B)

- **Tasks** (default): stage-grouped task view
- **Notes**: case-level handover notes with timeline display
- Documents absorbed into task cards (inline display)
- Journey absorbed into always-visible rail

### 7. More Actions — Dropdown Menu (Option A)

The ••• button opens a dropdown with grouped actions:
- Status: Mark Complete, Mark Waiting on Practice/GP/External
- Communication: Email Practice, Email GP, Send Nudge
- Management: Add Note, Set Follow-up Date, Escalate

---

## Phase 2 Features (deferred)

### AI Note Follow-ups (Option C)

**Part A — Note creation AI parsing:**
- When VA writes a note, send to Claude Opus for follow-up extraction
- AI extracts: action, condition, deadline
- Prompt VA to confirm auto-created follow-up task

**Part B — Daily reconciliation cron:**
- Runs daily, finds due/overdue follow-up tasks
- Checks Gmail for recent GP/practice activity
- Checks locally-stored DoubleTick messages (new `doubletick_messages` table)
- Binary AI verdict at 90% threshold: Fulfilled (auto-complete) or Not Fulfilled (bump to urgent)
- Model: Claude Opus, estimated cost ~$7.84/day at 1000 GPs scale

### Known Issues to Fix in Phase 2

| # | Issue | Fix |
|---|-------|-----|
| 1 | Missing `related_stage` on doc_review, manual, visa tasks | Backfill + make required on creation paths |
| 2 | No DoubleTick conversation history API | Store inbound webhook messages in `doubletick_messages` table |
| 3 | No stage locking enforcement | Visual-only in Phase 1 (derive from user_state), enforce in Phase 2 |
| 4 | Case management fields need home | Profile bar expand section |
| 5 | Follow-up → note linkage | Store source_timeline_id in task metadata |
| 6 | Ungrouped tasks fallback | "Other" group at bottom |
| 7 | Gmail search-by-GP function | New utility for reconciliation cron |
| 8 | Ops Queue tab rename | Label change only, keep internal data-tab="tasks" |

---

## Files Affected

- `pages/admin.html` — primary file, full UI restructure of GPs tab
- `server.js` — no API changes in Phase 1 (rendering-only changes)
- No new migrations in Phase 1

## No Changes To

- Medical Centres tab
- Support tab
- Authentication/session system
- API endpoints
- Database schema (Phase 1)
