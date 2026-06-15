# CEO Unified Workspace — Design

**Date:** 2026-06-15
**Branch:** `worktree-ceo-detach-email-routing`
**Status:** Design — awaiting user review before the implementation plan

## Goal

Make the CEO Command Centre a **single self-contained workspace** where every operational area lives in one place — **dark-themed**, leading with **Overview + RSO Oversight**, with the day-to-day work (ops tasks, calls, support, GPs) **reorganized under each RSO**. The CEO never gets bounced to the light "admin" page Hazel uses. RSOs (e.g. Hazel) keep their existing lighter page with their reduced tab set.

## Architecture decision (chosen: Option 1 — one engine, two skins)

**Evolve `pages/admin.html` into the single, role + theme-conditional workspace.** Do NOT duplicate the operational UI into `pages/ceo-dashboard.html`.

Why: `admin.html` already holds the ~7,800 lines of operational UI (Ops Queue, GPs, Medical Centres, Support, Guide, Calls, Technical) that RSOs depend on. Option 2 (porting it all into a separate dark CEO page) would clone that code into a second file that must be maintained in lockstep forever — guaranteed drift and double the bug surface. Option 1 keeps **one codebase** and renders it two ways by role:

- **Super-admin (CEO):** dark theme, nav leads with Overview + RSO Oversight, work reorganized per-RSO, Medical Centres + Technical as company-wide tabs.
- **RSO (Hazel):** unchanged — light theme, her current subset (Ops Queue, GPs, Support, Guide, Calls).

The standalone `pages/ceo-dashboard.html` is **retired** (redirects to `/pages/admin`). Its Overview + RSO Oversight rendering moves into `admin.html` as views. Everything already built carries over unchanged: `lib/ceo-metrics.js`, all `/api/ceo/*` endpoints, the migrations, the metric reconciliation.

## Theming approach (the foundation, and the main risk)

`admin.html` has one light `:root` and ~172 hard-coded light hex colours. To get a dark CEO skin without breaking the RSO light UI:

1. **Tokenize:** replace hard-coded colours with CSS variables (`var(--bg)`, `--panel`, `--text`, `--line`, `--blue`, etc.), reusing the token names already defined in `ceo-dashboard.html`'s dark theme so the two match.
2. **Additive dark override:** add a `body.ceo-dark { ... }` block that overrides those variables to the dark palette. Default (no class) stays **exactly** the current light theme — RSOs are untouched.
3. **Apply by role:** set `document.body.classList.add('ceo-dark')` only when `isSA()`.

This is done **first** so every subsequent area renders dark for free. It is the highest-risk step (a missed hard-coded colour = a light patch on a dark screen), so it gets its own phase + a visual pass.

## Per-area plan

| Area | Per-RSO? | Where it lives for the CEO | Notes |
|---|---|---|---|
| **Ops tasks** | Yes (via `case.assigned_rso`) | **Under RSO Oversight**, per RSO + an "Unassigned" bucket | `/api/admin/ops/queue` already loads the case; expose `assigned_rso` (1-line) + a `?rso=` filter. Caseless "Unknown" emails → Unassigned. |
| **Calls** | Yes (`scheduled_calls.assigned_rso_email`) | **Under RSO Oversight**, per RSO | Already RSO-tagged; `/api/admin/calls` works for super-admin. |
| **GPs** | Yes (strong) | **Under RSO Oversight** → RSO → their GPs → full case detail (tasks/notes/docs/timeline/calls) | Largest area. Reuses `/api/admin/case`, `/api/admin/tasks`, `/api/admin/gp-documents`, `/api/admin/calls`, `/api/admin/candidate-summary`. |
| **Support** | Partial | **Under RSO Oversight**, per RSO | Needs the support endpoint to include case-linked items + group by `assigned_rso` (today it filters `case_id IS NULL`). |
| **Medical Centres** | No (org-wide) | Its own company-wide dark tab | Read-only directory; `/api/admin/medical-centres` unchanged. |
| **Technical** | No (org-wide) | Its own company-wide dark tab | Server already CEO-gated (`/api/ceo/integrations`, `/api/ceo/technical/*`); front-end port only. |
| **Overview** | — | First tab (executive dashboard) | Folded in from `ceo-dashboard.html`; reuses `/api/ceo/dashboard` + drilldowns. |
| **RSO Oversight** | — | Second tab; the operational hub | Folded in; RSO cards → drill into an RSO → their ops/calls/support/GPs. |

**RSO Oversight becomes the spine.** For the CEO, the per-RSO drill-in is where ops tasks, calls, support, and GPs for that RSO all live — exactly the "everything under the corresponding RSO tab" you asked for.

## What stays the same for RSOs (Hazel)

`admin.html` light theme, her current tabs and flat lists, untouched. All role-conditional: `isSA()` gates the dark theme, the Overview/RSO-Oversight tabs, the per-RSO reorganization, and the Medical Centres/Technical tabs. A non-super-admin sees today's page.

## Phased build order

- **Phase A — Dark theme foundation.** Tokenize `admin.html` colours, add `body.ceo-dark`, apply on `isSA()`. Verify RSO light UI is pixel-unchanged and the CEO view is fully dark. (Foundational; highest CSS risk.)
- **Phase B — Fold in Overview + RSO Oversight.** Move the executive dashboard + RSO Oversight into `admin.html` as the first two super-admin views; retire the cross-links. (Now the CEO home is in-page.)
- **Phase C — Ops + Calls under RSO Oversight.** Per-RSO ops task board + calls inside the RSO drill-in. The headline win.
- **Phase D — GPs per RSO.** RSO → GP list → full case detail (the biggest area), dark.
- **Phase E — Support per RSO.** Endpoint change + per-RSO support inside the drill-in.
- **Phase F — Medical Centres + Technical.** Company-wide dark tabs.
- **Phase G — Retire `ceo-dashboard.html`** (redirect to `/pages/admin`), cleanup, final adversarial review + end-to-end verification.

Each phase ships independently and is verifiable on the preview branch, so you see progress at every step rather than at the end.

## Risks

1. **Theming regression for RSOs** — the dark override must be strictly additive; any missed hard-coded colour shows as a light patch. Mitigation: tokenize systematically + a visual diff pass for the RSO (light) path.
2. **GPs area size** — ~15 read + ~20 write endpoints; the riskiest port. It gets its own phase with end-to-end verification of each action.
3. **Support RSO attribution** — requires an endpoint change that could affect Hazel's support list; must stay backward-compatible for the RSO view.
4. **Scope** — this is large (xlarge). Phasing keeps each step reviewable and shippable.

## Verification

- Per phase: full vitest suite green, inline-script compiles, `node --check`, and a live read-only check against prod where data-backed (as done in the original rebuild).
- RSO (light) path explicitly verified unchanged after the theming phase.
- Final: adversarial multi-agent review + runtime smoke of every CEO surface.

## Out of scope

- No change to the GP-facing app.
- No change to RSO capabilities or their existing workflow beyond what's already shipped.
