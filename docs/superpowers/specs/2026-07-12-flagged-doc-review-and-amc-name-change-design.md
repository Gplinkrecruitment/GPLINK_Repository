# Design — Flagged-document review routing + AMC name-change notice

**Date:** 2026-07-12
**Author:** Claude (with hello@mygplink.com.au)
**Status:** Approved design, pending build

## Background

Dr Mercy Obanimoh's onboarding exposed three gaps (a separate, already-pushed branch
`worktree-onboarding-cert-not-required` fixes the wrongly-applied certified-copy check;
this spec covers the rest):

1. Her AI-flagged **Primary Medical Degree** produced **no review task at all** — the
   flag-task creation is fire-and-forget and silently failed on serverless.
2. She has **no assigned RSO** (not placed yet), and unassigned cases are **invisible to
   every regular RSO** by design (`server.js` ops-queue drops unassigned-case tasks) — so
   even a created task would be seen by nobody but the CEO.
3. Her degree is in a **former/maiden name** ("Biam Mercy Dzungwem") vs her account
   ("Mercy Obanimoh"). The AMC will require legal name-change evidence, and nothing in the
   app tells her or captures that a name change happened.

## Decisions (confirmed with owner)

- **Part 2 routing:** assign each unplaced-candidate document check to the **least-loaded
  RSO** (fewest open tasks), skipping on-leave RSOs. Shown in a distinct area, never in the
  RSO's GP caseload.
- **Part 3 scope:** at the AMC step, **inform only** — red notice + "Show me where"
  screenshot. The doctor uploads evidence in the real AMC portal; we do not collect it.

---

## Part 1 — Every flagged document reliably creates an approve/reject task

**Goal:** an AI-flagged qualification document always yields exactly one open review task,
even when the fire-and-forget pipeline dies.

**Changes:**
- Keep the existing synchronous `ensureDocReviewOnUpload` (`server.js:23732`) as the
  guaranteed create-on-upload path, but enrich it so a flagged (name-mismatch /
  failed-verification) doc yields the reasoned `flagged_doc` task rather than only the
  generic "awaiting RSO verification" one — so the reason survives even if
  `processDocumentUpload` (`server.js:23770`) never completes.
- Add a **reconciliation sweep** (cron, hourly — reuse the existing cron pattern): find
  `user_documents` with `status='under_review'` (or `flag_reason` set) that have **no open
  review task** for that (case, document_key), and create the routed task. This is the
  backstop that guarantees nothing is orphaned.
- De-dupe: a doc must never spawn two open tasks (respect the existing
  `createFlaggedDocTask` supersede-open-`doc_review` logic, `server.js:23647`).

**Result:** for a GP who already has an assigned RSO, the task shows in that RSO's Ops
Queue exactly as today (existing `assigned_rso` scoping already covers this).

## Part 2 — Route unplaced GPs' checks to the least-loaded RSO, kept separate

**Detection:** a flagged review task whose parent case has **no `assigned_rso` and no
`assigned_va`** = an "unassigned candidate document check."

**Routing (task-level, case stays unassigned):**
- On creating such a task (both the upload path and the reconciliation sweep), compute the
  **least-loaded active RSO** and set `registration_tasks.assignee` to their `user_id`.
  The case's `assigned_rso`/`assigned_va` stay **null** so the candidate never becomes a
  caseload GP.
- Least-loaded source: reuse `computeRsoWorkload(activeCases, tasks, roster, today)`
  (`lib/ceo-metrics.js:297`) → pick min `open_tasks` among roster RSOs that are `active` and
  **not** `on_leave`, excluding the hello@ archive mailbox and the `__unassigned__` bucket.
  Add a small helper `pickLeastLoadedRso(...)`. Tie-break: lowest `case_count`, then name.
- On-leave fallback: if every eligible RSO is on leave, leave `assignee` null (CEO still
  sees it via the unassigned view) — do not hard-fail.

**Visibility (the key scoping change):** today task auth is derived only from the case's
`assigned_rso`/`assigned_va`; `assignee` is ignored. Extend the two task feeds so a task is
visible to an RSO when **the case is theirs OR `task.assignee === their user_id`**:
- `GET /api/admin/ops/queue` (`server.js:52261`, filter at `~52303`).
- `GET /api/admin/tasks` (`server.js:45030`, filter at `~45048`).
Guard: only broaden visibility for these candidate-check task types on unassigned cases —
do not expose other RSOs' assigned-case tasks.

**Presentation (`pages/admin.html`, Ops Queue):** render a distinct **"Document checks"**
section for tasks that are `assignee === me` on an unassigned case. Framing copy:
"Candidate not placed — just verify this document; you won't be guiding them." Each row:
candidate name, doc type, AI reason, "Routed to you — fewest open tasks", **Review
document** (opens the existing doc-review modal with Approve / Reject). These candidates do
**not** appear in the assigned-GP caseload list.

## Part 3 — Name-change detection → AMC "YOUR ACTION" notice

**RSO-facing (make the difference explicit):** the doc-review AI-scan panel already reports
name match/mismatch. Ensure a **mismatch** is shown prominently: "Name on document
(X) differs from account (Y) — likely a name change. Approving records this as a name
change." (Modal in `pages/admin.html`; scan built in the `/api/admin/va/doc-review/ai-scan`
endpoint.)

**Persist on approval:** when an RSO **approves** a qualification doc whose scan
`nameMatch === 'mismatch'` (name genuinely differs), set a per-GP flag:
- New columns on **`user_profiles`**: `name_change_detected boolean default false` and
  `name_change_note text` (the differing name, e.g. "Document: Biam Mercy Dzungwem").
  (`registration_cases` has no `metadata` column in prod, so the flag lives on the profile.)
- Set in the doc-review approve handler.

**GP-facing AMC (`pages/amc.html`, "Establishment" = `upload_credentials` tab):** when the
flag is set and the active tab is `upload_credentials`:
- Show the red warning box: reuse `#stepWarning` (`amc.html:1150`) with a new
  `.warn.warn-danger` modifier (red tokens `--gp-red*`), toggled in `renderStepContent`
  (`amc.html:1682/1700`).
- Append a red name-change block to the `.action-card` (`amc.html:1718`) listing acceptable
  evidence: Marriage Certificate, Change of Name legal document, Deed Poll, Birth
  Certificate.
- Add a **"Show me where"** button → opens a new modal (clone the `#supportModal` /
  `openModal()` pattern, `amc.html:1186/1462`) containing
  `<img src="/media/images/amc-name-change-reference.png">`.

**Data path to the AMC page:** the AMC page hydrates from `/api/state`
(`js/state-sync.js:49`). Expose `nameChangeDetected` (+ optional note) on the `/api/state`
response, sourced server-side from `user_profiles`, so the page can read it on load with no
new fetch. (Alternative: have the page call `/api/profile`; prefer the `/api/state` route.)

**Asset:** add `media/images/amc-name-change-reference.png` (the AMC portal "2.4 Evidence"
screenshot the owner provided). Distinct from the existing pre-staged
`amc-credentials-reference.png`.

---

## Data-model changes

- `user_profiles.name_change_detected boolean default false`
- `user_profiles.name_change_note text null`
- (`registration_tasks.assignee` already exists — no migration.)
- New hourly reconciliation cron (schedule + handler).

## Files touched

- `server.js` — reliable flag-task creation + reconciliation cron; `pickLeastLoadedRso`
  routing; ops-queue & tasks `assignee` visibility; doc-approve name-change flag; `/api/state`
  exposes the flag.
- `lib/ceo-metrics.js` — reuse `computeRsoWorkload`; add `pickLeastLoadedRso`.
- `pages/admin.html` — "Document checks" section + framing; ensure the name-difference shows
  in the review modal.
- `pages/amc.html` — red name-change warning + action-card block + "Show me where" modal;
  `.warn-danger` CSS.
- `supabase/migrations/<ts>_user_profiles_name_change.sql` — the two columns.
- `media/images/amc-name-change-reference.png` — new asset.

## Testing / verification

- **Unit:** `pickLeastLoadedRso` picks fewest open tasks, skips on-leave, excludes archive;
  scoping includes `assignee === me` tasks on unassigned cases but not other assigned-case
  tasks.
- **End-to-end (the Mercy path):** unplaced GP uploads a flagged qual → task created +
  assigned to least-loaded RSO → appears in "Document checks", **not** the caseload →
  RSO sees the name difference → approves → `name_change_detected` set → AMC "Establishment"
  step shows the red notice + working "Show me where" → reconciliation sweep creates a task
  if the live one was missed.

## Out of scope

- Auto-assigning a case to an RSO on placement (unchanged; still manual).
- Collecting the name-change evidence inside our app (owner chose inform-only).
- The certified-copy fix (separate branch, already pushed).
