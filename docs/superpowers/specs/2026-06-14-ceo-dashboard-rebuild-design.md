# CEO Command Centre — Rebuild Design

**Date:** 2026-06-14
**Branch:** `worktree-ceo-detach-email-routing`
**Status:** Design — awaiting user review before implementation plan

## Goal

Rebuild the CEO Command Centre as a **standalone page, fully detached from the RSO view**, giving the CEO an oversight lens over the same work: see **all RSOs**, the **GPs under each RSO**, **all important metrics**, and the ability to **open and complete / reassign / escalate any task directly** (full admin power). Every number must be trustworthy and every action must work end-to-end.

This rebuild also fixes the **70 confirmed discrepancies** found in the end-to-end audit (`audit-summary.txt`, 23 high / 27 medium / 20 low). Scope: **fix all 70.**

## Terminology decision (important)

The role currently stored as `assigned_va` and labelled "VA" / "VA Workload" is, per the user, the same people as the **RSO** team — and "VA" is to be retired from all user-facing copy as unprofessional. Throughout the CEO (and RSO) UI the term is **RSO**. The internal Gmail-mailbox mechanics that legitimately concern a monitored inbox (e.g. Hazel's) keep their internal field names but are never surfaced as "VA".

## Requirements

1. CEO page is its own route + nav, not an iframe panel inside `admin.html`.
2. Server-side super-admin auth gate on the CEO page (currently client-side only — security gap, finding #50/#69/#70).
3. Oversight: list every RSO, drill into each RSO's GPs and their workload, per-RSO metrics.
4. Durable per-GP RSO ownership the CEO can assign/reassign; editable RSO roster (no code deploy to add an RSO).
5. Every KPI reconciles exactly with its drilldown.
6. Every action modal persists and reflects back.
7. Integration health reflects reality.
8. "VA" removed from CEO/RSO user-facing copy → "RSO".

## Architecture

### A. Single source of truth for metrics (`lib/ceo-metrics.js`)

**Root cause of ~30 of the 70 bugs:** the dashboard endpoint computes each KPI, and the drilldown endpoint *independently re-computes the same thing* with divergent status sets, date math, period/active-case filters, and row caps. KPIs and their drilldowns therefore disagree (findings #1, #2, #3, #6, #9, #10, #11, #12, #29, #30, #34, #38, #51).

**Fix:** extract one module that defines, **exactly once**:
- `activeCases(cases)` — the withdrawn / 6-month-stale exclusion (and an explicit "true all-time" mode so an "All Time" label means all time — findings #15, #52).
- `withinPeriod(row, period, field)` — the period window, applied to the *correct* timestamp per metric (findings #18, #43, #51).
- Canonical **status sets** (`OPEN_TASK_STATUSES`, `OVERDUE_EXCLUDED`, `SECURED_APPLICATION_STATUSES` reusing the existing `isCareerPlacementSecuredStatus` at server.js:10126 — finding #8), so "overdue", "open", "secured" mean one thing everywhere.
- One function per metric (`overdue(tasks)`, `pipeline(cases, {cumulative})`, `blockedByStage(...)`, `placements(...)`, `gpActivityBuckets(...)`, `ticketMetrics(...)`, `completions(...)`).

Both `GET /api/ceo/dashboard` and `GET /api/ceo/drilldown/{section}` consume these. A KPI and its drilldown become **the same query with `count` vs `rows`** — they cannot drift. Pure functions → directly unit-testable (see Testing).

Specific semantics this nails down:
- **Overdue**: `due_date` is a DATE column; "overdue" = `due_date < today` (calendar), one status set including/excluding `escalated` consistently (findings #1, #30).
- **Funnel**: one cumulative-vs-snapshot model shared by bar and drilldown; blocked counted once at current stage, not per passed stage (findings #2, #3); funnel ordered by true DB progression (#28); `visa`→`pbs` remap applied in both count and drilldown (#56).
- **Aggregates over capped row sets** (avg resolve, ticket averages, trend counts) computed without silent 500/1000/2000 caps — server-side count/range queries or explicit windows (findings #31, #39, #53, #63).

### B. Metric semantics corrections

Metrics that measure the wrong thing get corrected or relabelled:
- `days_in_stage` is days-since-GP-activity, not time-in-stage → add a `blocker_set_at` timestamp and compute days-blocked from it; single label across card + drilldown (findings #5, #57, #58).
- "Avg 1st Reply" stamps `first_reply_at` only at close, so it equals resolution time → stamp on first VA/admin thread reply, or hide until real (finding #13).
- "Placed" omits Zoho's `Placed` status → use the shared secured-status helper (finding #8).
- `recent_milestones` returns events of the highest-sorted `case_id`, not the globally most recent → sort by `created_at DESC` globally; humanise stage slugs; restrict to genuine wins (findings #14, #41).
- KPI trend arrows: "Completed" arrow driven by `placements_secured`; arrows compare weekly flow under a snapshot total → map each arrow to its own series or relabel as flow; dedupe placements by GP (findings #16, #17, #25, #42).
- `escalated_by` hardcoded to "VA" → record the real escalator (finding #27).
- Velocity misses transitions that skip the live path → log `stage_change` wherever `stage` is PATCHed (finding #35).
- `in_progress` computed but never rendered (#59); placement bucket comment/dead var (#60, #61); `this_month` UTC boundary + `completed_at`-only (#62); cold-GP list sort-before-slice (#36, #37); escalation resolved-dedup heuristic + reason matching (#53, #54, #55).

### C. RSO oversight (new capability)

- New table **`rso_team`** (`user_id, name, email, phone, active`) replacing the hardcoded `RSO_TEAM` array (seeded from it). `GET /api/ceo/rsos` returns each RSO with aggregated metrics (findings #22).
- New column **`registration_cases.assigned_rso`** (uuid), backfilled from `assigned_va`, indexed. This is the **durable per-GP owner** used for all oversight grouping (finding #23). `assigned_va` is retained only for the Gmail-mailbox mechanics; it is never surfaced as "VA".
- The "VA Workload" section becomes **"RSO Workload"**, grouping by `assigned_rso`, attributing task counts correctly (findings #33, #7, #32, #34).
- CEO can assign/reassign a GP's RSO from the CEO view → a proper **RSO picker** (dropdown from `rso_team`), replacing the raw free-text UUID box (finding #44).
- New `GET /api/ceo/rso/:id/summary` (GPs + task rollup for one RSO) and per-RSO filters on the relevant list endpoints.

### C.1 RSO transfer carries the GP's email (build on existing machinery)

When a GP is transferred to another RSO, the GP's labeled email threads must be **archived out of the old RSO's mailbox and delivered to the new RSO's mailbox, labeled under their assigned-GP label**.

**This largely already exists** in the owner-change branch of `PUT /api/admin/case` (server.js:29593-29728), triggered today on `assigned_va` change:
- `archiveLabelForVA` renames the old owner's label `Assigned/Dr X` → `Archived/Dr X` (server.js:3348) — the threads stay in the old mailbox but as an archived folder.
- It fetches the GP's labeled message history (raw) from the old mailbox.
- `createLabelsForCase` makes the `Assigned/Dr X` label in the new owner's mailbox, and `insertSilentCopy` writes the history into it (server.js:29652-29659) — i.e. the threads are delivered to the new RSO's email under their label.
- The `hello@` archive label is renamed to the new owner (`buildHelloLabelName`).
- It backfills by searching the new mailbox for the GP's address and labeling matching threads.

**Rebuild work (wire + harden, don't rebuild):**
- The CEO's RSO-reassignment action sets `assigned_rso` **and** drives this Gmail transfer. Because the mailbox follows the owner, `assigned_rso` and the mailbox-owner field move together on transfer (keep `assigned_va` in sync, or migrate the transfer trigger to key off `assigned_rso`). Grouping/oversight reads `assigned_rso`.
- **Each RSO in the roster must have a registered Gmail mailbox** (`va_gmail_accounts`). Today if the new owner has no `va_gmail_accounts` row, `vaAcc` is null and the whole transfer silently no-ops inside a try/catch. The reassignment UI must require/verify the target RSO has a mailbox and surface a clear error instead of silently failing.
- Verify end-to-end: after transfer, the old RSO shows the GP under `Archived/`, the new RSO sees the GP's threads under `Assigned/Dr X`, and `hello@` reflects the new owner.
- (Optional, confirm with user) the current flow copies into the new mailbox but does not remove messages from the old mailbox's INBOX — only the label is moved to `Archived/`. If stricter separation is wanted (e.g. when an RSO leaves the team), add `removeLabelIds`/cleanup. Default: keep the archived copy.

### D. Action reliability

- "Set Blocker → Blocked" violates the `blocker_status` CHECK constraint → fix the option mapping (send `status:'blocked'` + valid/null `blocker_status`) (findings #4, #19).
- "Escalate to CEO" sends string `"CEO"` into a UUID column → stop sending it / make `escalated_to` a role marker; preserve `escalated_by`/reason; deliver the CEO's "Add Note & Return" as an actionable message to the RSO, not just a timeline row (findings #26, #55).
- "Add Note" ignores its `taskId` → tie task-context notes to the task (finding #64).

### E. Standalone page + auth hardening

- `pages/ceo-dashboard.html` becomes a standalone CEO page: own route, own top nav (no longer an iframe inside `admin.html`); keeps its 11 working sections + new RSO oversight.
- **Server-side gate**: serve the CEO page only with a valid `super_admin` session on the super-admin host scope (findings #50, #69, #70). Reuse `requireSuperAdminSession` / host-scope logic that already protects `admin.html`.
- Full admin actions reuse `/api/admin/*`; oversight reads use `/api/ceo/*`.

### F. Integration / Technical honesty

Gmail "processed 24h" wrong column → query `processed_at` (#20); reconnect returns ok even on total failure → reflect per-mailbox result (#46); DoubleTick fake-healthy probe → real authenticated check (#45); Gmail card hardcoded to one mailbox → iterate `MONITORED_VA_EMAILS` (#47); User Bugs panel missing `error_stack`/`first_seen_at` (#21, #48); Zoho Sign reconnect has no re-auth path (#65); dead "Agent Control" tab (#66); false-success toasts on Sync/Sweep (#67); off-screen no-op tools (#68); Reset GP body-parse fallback (#49).

## Workstream → findings map

| WS | Theme | Findings |
|----|-------|----------|
| W0 | Standalone page + nav | page detachment |
| W1 | Single source of truth (metric ↔ drilldown reconciliation; wire clickable KPI tiles to their drilldowns) | #1,#2,#3,#6,#9,#10,#11,#12,#24,#28,#29,#30,#31,#34,#38,#39,#40,#51,#52,#56,#63 |
| W2 | Metric semantics correctness | #5,#8,#13,#14,#15,#16,#17,#18,#25,#27,#35,#36,#37,#41,#42,#43,#53,#54,#57,#58,#59,#60,#61,#62 |
| W3 | RSO oversight + terminology + email transfer on reassignment | #22,#23,#33,#7,#32,#44; VA→RSO rename; wire/harden Gmail thread transfer (§C.1) |
| W4 | Action reliability | #4,#19,#26,#55,#64 |
| W5 | Auth hardening | #50,#69,#70 |
| W6 | Integration / Technical honesty | #20,#21,#45,#46,#47,#48,#49,#65,#66,#67,#68 |

## Data flow

Browser (standalone CEO page, super-admin session)
→ `GET /api/ceo/dashboard?period=…` and `GET /api/ceo/rsos` (oversight reads, via `lib/ceo-metrics.js`)
→ drill in: `GET /api/ceo/drilldown/{section}` / `GET /api/ceo/rso/:id/summary` (same metrics module → counts reconcile with rows)
→ act: `/api/admin/task` (complete/reassign/escalate), `/api/admin/case` (RSO reassign, blocker, stage), `/api/admin/case/note`, `/api/ceo/escalation/*`
→ 30s refresh re-reads the dashboard so actions reflect back.

## Error handling

- Action modals check `res.ok` AND parsed `{ok}` before showing success; surface server `message` on failure (findings #46, #67).
- DB constraint-safe payloads (blocker_status, escalated_to) so saves don't silently fail (#4, #19, #26).
- Migrations are additive + backfilled (`assigned_rso`, `rso_team`, `blocker_set_at`) — no destructive renames of heavily-referenced columns.

## Testing / verification

- **Unit tests (vitest)** for `lib/ceo-metrics.js`: each metric over a fixture dataset, asserting KPI value == drilldown row count for every section and period. This is the regression wall against the entire "numbers that lie" class.
- **End-to-end verification** (run/verify skill): load the CEO page as super-admin, exercise each action modal (Set Blocker, Reassign RSO, Escalate, Add Note), confirm DB persistence and read-back after refresh.
- Auth: confirm the CEO page 302/403s for unauthenticated and non-super-admin sessions and on the wrong host.

## Out of scope

- Already shipped on this branch: email-triage infra-sender filter; stopping `hello@` inbox monitoring.
- No change to the GP-facing app or the RSO operational workflow beyond the VA→RSO relabel.

## Open points for user review

1. `assigned_rso` is introduced as the durable owner, backfilled from `assigned_va`; `assigned_va` stays only for Gmail-mailbox routing. Confirm this split is acceptable (vs. fully migrating off `assigned_va`).
2. Escalation target: make `escalated_to` a role marker ("CEO") rather than a user UUID — confirm there's no need to escalate to a *specific* person.
3. "Avg 1st Reply" metric: fix the stamp, or drop the tile until a real first-reply signal exists? → **CONFIRMED: fix it properly.**
4. RSO transfer email handling (§C.1): default is to keep the archived copy in the old RSO's mailbox (label moved to `Archived/`) rather than deleting it. Confirm that's acceptable vs. hard-removing from the old mailbox.

## Confirmed decisions (2026-06-14)

- `assigned_rso` as durable owner, backfilled from `assigned_va`; `assigned_va` retained only for internal Gmail mechanics (CONFIRMED).
- "Escalate to CEO" as a role marker, not a specific person (CONFIRMED).
- Fix "Avg 1st Reply" properly (CONFIRMED).
- Scope: fix all 70 (CONFIRMED).
- On RSO transfer, the GP's labeled threads archive from the old RSO and are delivered+labeled to the new RSO's mailbox — build on the existing owner-change machinery (§C.1) (CONFIRMED requirement).
