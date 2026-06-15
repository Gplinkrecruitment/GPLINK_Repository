# CEO Unified Workspace — Design (Separate Build)

**Date:** 2026-06-15 (revised after user direction)
**Branch:** `worktree-ceo-detach-email-routing`
**Status:** Design — awaiting user review before the implementation plan

## Goal

Make the CEO Command Centre a **single self-contained dark workspace** where every operational area lives in one place, with the day-to-day work (ops tasks, calls, support, GPs) **reorganized under each RSO**. The CEO never leaves their own page.

## HARD CONSTRAINT (user direction)

**Do NOT touch the RSO admin page.** `pages/admin.html` (Hazel's screen) must be left completely alone — no edits, no risk. This is a **separate build**: all new work lives in the CEO's own page.

## Architecture (Separate Build)

- **All CEO UI is built into `pages/ceo-dashboard.html`** (already dark) — the operational areas become in-page tabs under the existing unified nav, with ops/calls/support/GPs organized under **RSO Oversight** per RSO.
- **`pages/admin.html` is NOT modified.** Hazel keeps her exact current page. (It already contains super-admin-only links to the CEO page; those are harmless to RSOs and are left as-is — no further edits.)
- **Server:** add NEW `/api/ceo/*` read endpoints for the CEO's per-RSO data (ops, calls, support, GP rosters, case detail). Do **not** change the shape/behavior of existing `/api/admin/*` endpoints (Hazel's page depends on them). For **actions** (complete task, resolve email, send reply, upload/approve document, schedule call, etc.) the CEO page **reuses the existing `/api/admin/*` action endpoints** — they are admin-session gated and a super-admin passes; calling them changes nothing about Hazel's UI.
- **The CEO page links to `/pages/admin` are removed** (the work now lives in-page), so the CEO never bounces to Hazel's screen.

**Accepted trade-off:** the operational render logic is re-implemented (dark) in the CEO page rather than shared with `admin.html`. This is duplication that must be kept roughly in sync over time — accepted in exchange for never touching/risking the RSO admin page. (This is the "Option 2" cost we discussed.)

## What carries over unchanged

`lib/ceo-metrics.js`, all existing `/api/ceo/*` endpoints, the two migrations, the metric reconciliation, the dark theme tokens, auth gating, and the Overview + RSO Oversight tabs already in the CEO page. We build **on top** of the CEO page that already exists.

## Per-area plan (all built in the dark CEO page)

| Area | Per-RSO? | Where it lives | Data |
|---|---|---|---|
| **Ops tasks** | Yes (`case.assigned_rso`) | Under RSO Oversight → each RSO + "Unassigned" | NEW `/api/ceo/rso/:id/ops` (reads the same tasks as `/api/admin/ops/queue`, grouped by RSO). Caseless "Unknown" emails → Unassigned. Actions reuse existing endpoints. |
| **Calls** | Yes (`scheduled_calls.assigned_rso_email`) | Under RSO Oversight → each RSO | NEW `/api/ceo/rso/:id/calls` (or reuse `/api/admin/calls` read-only, filtered client-side). |
| **GPs** | Yes | Under RSO Oversight → RSO → GP list → full case detail (tasks/notes/docs/timeline/calls) | Reuse read endpoints (`/api/admin/case`, `/api/admin/tasks`, `/api/admin/gp-documents`, `/api/admin/candidate-summary`); actions reuse existing. Largest area. |
| **Support** | Partial | Under RSO Oversight → each RSO | NEW `/api/ceo/rso/:id/support` that includes case-linked tickets grouped by `assigned_rso` (does not alter the existing admin support endpoint). |
| **Medical Centres** | No (org-wide) | Its own company-wide dark tab | Read-only; reuse `/api/admin/medical-centres` (GET). |
| **Technical** | No (org-wide) | Its own company-wide dark tab | Server already CEO-gated (`/api/ceo/integrations`, `/api/ceo/technical/*`); front-end only. |
| **Overview** | — | First tab (already built) | `/api/ceo/dashboard` + drilldowns. |
| **RSO Oversight** | — | Second tab; the spine | Already built; gains the per-RSO ops/calls/support/GPs drill-in. |

**RSO Oversight is the spine:** for the CEO, opening an RSO shows that RSO's ops tasks, calls, support, and GPs — "everything under the corresponding RSO tab," exactly as asked.

## Phased build order (each ships to preview)

- **Phase 1 — In-page shell + Ops under RSO Oversight.** Convert the CEO nav's operational items from links-to-admin into in-page tabs (dark panels); build the per-RSO ops task board inside the RSO drill-in (`/api/ceo/rso/:id/ops`), actions wired to existing endpoints. The headline win + the self-contained shell.
- **Phase 2 — Calls under RSO Oversight.** Per-RSO calls in the drill-in.
- **Phase 3 — GPs per RSO.** RSO → GP list → full dark case detail. The biggest area; its own phase with end-to-end action verification.
- **Phase 4 — Support per RSO.**
- **Phase 5 — Medical Centres + Technical** as company-wide dark tabs.
- **Phase 6 — Final adversarial review + live verification + cleanup** (confirm `admin.html` is byte-for-byte untouched).

## Risks

1. **Duplication drift** — the CEO ops/GPs/calls render logic duplicates admin.html's; future changes must be applied in both. Mitigation: reuse the same server endpoints/data so only the rendering differs, and document the paired locations.
2. **GPs area size** — the largest port (~15 read + ~20 action endpoints); its own phase + per-action verification.
3. **Action reuse correctness** — the CEO page calls `/api/admin/*` action endpoints; verify each persists and reads back (no change to those endpoints).

## Non-negotiable verification each phase

- Full vitest suite green, inline-script compiles, `node --check`.
- **`git diff` confirms `pages/admin.html` is unchanged** (the hard constraint).
- Live read-only reconciliation/runtime check where data-backed.

## Out of scope

- No change to `pages/admin.html` or the RSO experience.
- No change to the GP-facing app.
