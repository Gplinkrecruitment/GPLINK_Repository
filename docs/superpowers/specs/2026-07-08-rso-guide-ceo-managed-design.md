# RSO Guide — CEO-managed, RSO-readable (design)

**Date:** 2026-07-08
**Branch:** worktree-ai-matching-build (preview only, per preview-branch working mode)

## Goal

Rename the CEO dashboard's "RSO" master tab to **Registration**, give it a two-item
sub-nav (**RSOs** / **Guides**), and let the CEO manage the how-to Guide from the
**Guides** sub-tab. RSOs continue to read the same Guide in their dashboard
(pages/admin.html) but can no longer edit it. One shared component drives both
surfaces so they never drift.

## What the Guide already was

An existing folders → items library of Scribe how-to recordings, editable in
pages/admin.html (`view=guide`), stored in `guide_folders` / `guide_items`, served
by `/api/admin/guide/*`. The write endpoints were **already** gated to the CEO
(`requireCeoSession`); only the read endpoint (`GET /folders`) is open to any admin.
So the "only CEO can edit" guarantee already held server-side — no server change.

## Design

1. **Shared component `js/guide-panel.js`** — self-contained (`window.GuidePanel.mount(el, { canEdit })`):
   own namespaced `.gpg-*` CSS injected once, own state, container-scoped click +
   drag listeners. `canEdit:false` renders zero edit controls. Faithful extraction
   of the previous admin.html inline guide (nested folders, expand/collapse, Scribe
   embed parse, top-level drag reorder, add/rename/delete folder & item).

2. **CEO dashboard (`pages/ceo-dashboard.html`)**
   - "RSO" master tab relabelled **Registration** (`data-mtab` stays `rso`, so the
     switcher, `?tab=rsos` deep link, and consultant-hiding all keep working).
   - `#panel-rso` gains a sub-nav (`#regSubnav`, `.reg-subtab` → RSOs | Guides).
     RSOs (default) keeps `#rsoContent` / `loadRsoOversight()`. Guides lazily mounts
     `GuidePanel.mount('ceoGuidePanel', { canEdit: true })` on first open.
   - The old pop-out "Guide" top-nav link + the now-empty `#ceoTopNav` are removed.

3. **RSO dashboard (`pages/admin.html`)** — the Guide tab now mounts
   `GuidePanel.mount('guidePanel', { canEdit: false })` (read-only for everyone; all
   editing happens in the CEO dashboard, per owner decision). The ~208 lines of inline
   guide editor code are removed.

## Permissions (end-to-end)

- Read: `GET /api/admin/guide/folders` → `requireAdminSession` (RSOs can watch).
- Write (create/rename/delete/reorder folders & items): `requireCeoSession` (CEO only).
- `canEdit` only decides which buttons render; a non-CEO can never mutate the guide.

## Tests

- `tests/guide-panel-shared.test.js` — module API, read-only gating, admin read-only
  mount, CEO editable mount, and the server write-gate guarantee.
- `tests/ceo-standalone-ui.test.js` — updated for the Registration label, sub-nav, and
  removed pop-out Guide link.

## Not doing (YAGNI)

- No server change (already correct). No new DB tables. No separate "RSO-only" guide —
  it's the same single library everywhere.
