# Unified Preview Consolidation — Design

**Date:** 2026-06-13
**Branch:** `worktree-unified-preview` (preview only — never merged to main by this work)
**Requested:** "Upgrade the whole GP Link app and complete it with functioning admin, tasks, etc., extrapolating from what has been built previously. Deploy to preview, not main."

## Problem

Main is healthy and contains all six recent feature plans (Zoho contract enrichment, admin mobile responsive, GP profile task parity, SWR caching, weekly backup, AHPRA task classification — all verified implemented). What is *incomplete* is:

1. **Four unmerged feature branches** (all 0 behind main) that have never been seen together in one build:
   - `worktree-unified-call-task` (18 commits; superset of `worktree-prepared-doc-mismatch-flagging`): doc-mismatch flagging pipeline, scan/missing-doc uploads through server pipeline, GP email routing to RSO, "Schedule call?" on assistance tasks.
   - `worktree-doc-upload-fix` (1 commit): admin placeholder upload landing in Other Files.
   - `worktree-admin-dashboard-cleanup` (17 commits): admin.html design-token system + calm ops-console restyle, 3 JS bug-fix classes, admin/user host separation, admin enabled on Vercel previews.
   - `worktree-gp-user-facelift` (12 commits): `css/gp-tokens.css` design system across all GP pages, dark-mode overrides, `vercel.json` css/** includeFiles fix, pbs upload retry + my-documents showToast fixes.
2. **Deliberately descoped follow-ups** from the admin cleanup (recorded in project memory):
   - Typography token scale (`--fs-*`) in admin.html; stray 9px/12.5px/rem sizes.
   - `escAttr()` does not entity-encode double quotes.
   - Grey tokens unconsolidated (`--border` ≡ `--line` duplicate).
   - ~20 hardcoded box-shadows in admin.html.
3. **Stale docs:** CLAUDE.md still says the Visa step is deferred; it was re-enabled 2026-05-12.

## Approach

Considered:
- **A. Cherry-pick selected features onto a fresh branch** — loses branch history, high risk of missing interdependent commits.
- **B. Sequential merges into one consolidation branch (chosen)** — preserves history, each merge is testable, conflicts resolved with an explicit principle.
- **C. Merge everything to main behind flags** — explicitly ruled out by the request (preview only).

## Design

### Merge order (smallest functional → largest cosmetic)
1. `worktree-unified-call-task` (functional; includes doc-mismatch-flagging)
2. `worktree-doc-upload-fix` (functional)
3. `worktree-admin-dashboard-cleanup` (admin restyle + host separation)
4. `worktree-gp-user-facelift` (GP page restyle + tokens)

**Conflict-resolution principle:** keep *functionality* from the call-task/doc branches and *styling/markup structure* from the cleanup/facelift branches. Where a functional commit added UI (e.g. mismatch badge, Schedule call button), restyle that UI with the destination branch's tokens rather than dropping it. `supabase/migrations/20260612000000_practice_doc_ops_drive_file_id.sql` appears on three branches — keep the superset.

### Completion follow-ups (after merges, admin.html only)
- Harden `escAttr()` to entity-encode `"` (and `'`).
- Consolidate `--line` into `--border`.
- Tokenize remaining hardcoded box-shadows into the existing shadow tokens.
- Add `--fs-*` typography scale and map stray font sizes onto it. JS-generated inline styles stay untouched (matches original audit scope).

### Docs
- Update CLAUDE.md's stale "Visa deferred" note to reflect the step being live again.

### Testing & verification
- `vitest run` (full suite) after each merge and at the end, via `/tmp/node-v20.19.6-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run` with node_modules symlinked from the main checkout.
- `node -c`-equivalent syntax check on server.js (`node --check`).
- Push `worktree-unified-preview` to origin → Vercel auto-creates the preview deployment. Main is never touched.

### Error handling / risks
- admin.html is changed by 3 merged branches → highest conflict risk; resolve hunk-by-hunk, verify no orphaned JS handlers (the cleanup branch renamed/tokenized classes the functional branches may reference).
- Cache busters: any `js/*.js` changed in conflict resolution needs its `?v=` bumped (`?v=20260613`).
- Admin login on the preview requires ADMIN_EMAILS/AUTH_SECRET/Supabase env vars in Vercel's Preview environment (already configured per 2026-06-12 work; host scope returns `'preview'` on previews).

## Out of scope

- Merging anything to main, production deploys.
- JS-generated inline styles in admin.html (~390 occurrences).
- New features beyond the recorded descoped follow-ups.
