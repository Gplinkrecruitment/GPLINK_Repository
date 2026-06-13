# Unified Preview Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One preview branch (`worktree-unified-preview`) that merges all four unmerged feature branches, completes the descoped admin.html follow-ups, and deploys to a Vercel preview — main untouched.

**Architecture:** Sequential `git merge` of each feature branch into the consolidation branch (functional branches first, cosmetic restyles second), conflict resolution by principle (functionality from call-task/doc branches, styling from cleanup/facelift branches), then four small targeted admin.html completion edits. Tests after every task.

**Tech Stack:** vanilla JS/HTML monolith (`server.js`, `pages/*.html`), vitest, git, Vercel git-integration previews.

**Environment facts (this machine):**
- Node binary: `/tmp/node-v20.19.6-darwin-arm64/bin/node` (no system node/npm).
- Worktree: `/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/unified-preview` (branch `worktree-unified-preview`). All commands below run from this directory unless stated.
- Tests: `/tmp/node-v20.19.6-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run` — requires `node_modules` symlinked from the main checkout (Task 0).
- Pushes only from the main session (SSH deploy key); subagents must NOT push. Remote branch push auto-creates the Vercel preview.

---

### Task 0: Worktree test setup + baseline

**Files:** none (environment only)

- [ ] **Step 1: Symlink node_modules into the worktree**

```bash
ln -s "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/node_modules" node_modules
```

(`node_modules` is gitignored; symlink shares the main checkout's install incl. arm64 natives.)

- [ ] **Step 2: Run the baseline test suite**

Run: `/tmp/node-v20.19.6-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run`
Expected: all tests pass (record the count — this is the baseline for every later task).

---

### Task 1: Merge worktree-unified-call-task

**Files:** merge touches `server.js`, `lib/document-pipeline.js`, `js/qualification-scan.js`, ~18 `pages/*.html`, 2 migrations, tests.

- [ ] **Step 1: Merge**

```bash
git merge worktree-unified-call-task --no-edit
```

Expected: clean or conflicts. If conflicts: resolve keeping BOTH sides' intent — this branch adds doc-mismatch flagging, server-pipeline uploads, GP→RSO email routing, Schedule-call buttons. Nothing on our branch yet conflicts except docs.

- [ ] **Step 2: Verify and test**

Run: `/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js && /tmp/node-v20.19.6-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run`
Expected: syntax OK; tests ≥ baseline count, all pass (branch adds document-pipeline + scheduled-calls tests).

- [ ] **Step 3: Commit (if conflicts were resolved manually, `git commit --no-edit` completes the merge)**

---

### Task 2: Merge worktree-doc-upload-fix

**Files:** merge touches `pages/admin.html`, `server.js`, migration `20260612000000_practice_doc_ops_drive_file_id.sql`.

- [ ] **Step 1: Merge**

```bash
git merge worktree-doc-upload-fix --no-edit
```

The migration file exists on both sides — resolve to the SUPERSET of statements (compare hunks; keep all distinct DDL).

- [ ] **Step 2: Verify and test** — same commands as Task 1 Step 2, all pass.

- [ ] **Step 3: Complete merge commit if needed**

---

### Task 3: Merge worktree-admin-dashboard-cleanup

**Files:** merge touches `pages/admin.html` (token system + full restyle), `server.js` (host separation), `tests/admin-host-separation.test.js`, docs.

- [ ] **Step 1: Merge**

```bash
git merge worktree-admin-dashboard-cleanup --no-edit
```

Conflict principle for `pages/admin.html`: take the cleanup branch's CSS/markup/token structure; KEEP the functional UI merged in Tasks 1–2 (name-mismatch badge, Schedule-call button, upload routing handlers) and restyle those elements with the cleanup tokens (`var(--line)`, `.btn`, `.task-badge`, etc.) instead of dropping them. For `server.js`: host-separation code (getAdminHostScope, USER_SESSION_CREATING_PATHS) and call-task email routing are different regions — keep both.

- [ ] **Step 2: Orphan check** — the cleanup branch renamed/tokenized classes; grep the merged admin.html for references to classes/ids that no longer exist in its `<style>` block (spot-check the elements added by Tasks 1–2).

- [ ] **Step 3: Verify and test** — `node --check server.js` + full vitest run, all pass including `tests/admin-host-separation.test.js`.

- [ ] **Step 4: Complete merge commit**

---

### Task 4: Merge worktree-gp-user-facelift

**Files:** merge touches `css/gp-tokens.css` (new), ~24 `pages/*.html`, `js/app-shell.js`, `js/qualification-scan.js`, `js/registration-stepper.js`, `js/updates-sync.js`, `vercel.json`, `server.js`.

- [ ] **Step 1: Merge**

```bash
git merge worktree-gp-user-facelift --no-edit
```

Conflict principle for user pages (`pages/*.html`, `js/*.js`): take the facelift branch's styling/markup; KEEP functional changes from Task 1 (scan/missing-doc upload routing, Schedule-call). `js/qualification-scan.js` is changed by both — facelift aligned its injected UI to tokens, call-task changed upload routing; merge both (different concerns, likely different functions). `vercel.json`: keep `css/**` in includeFiles plus any cron entries from main. Dark-mode pages (career, job, interview-prep, application-detail, offer-review, area-guide) must keep their `html.dark-mode { --gp-* }` override blocks intact.

- [ ] **Step 2: Cache busters** — any `js/*.js` file whose merged content differs from BOTH parents (i.e. hand-resolved) needs its `?v=` bumped to `?v=20260613` in every page referencing it. Check: `git diff HEAD --name-only -- js/` after resolution; grep pages for stale `?v=` on those files.

- [ ] **Step 3: Verify and test** — `node --check server.js` + full vitest run, all pass. Also `grep -c "gp-tokens.css" pages/*.html | grep -v ":0"` to confirm token links survived, and confirm `vercel.json` still parses: `/tmp/node-v20.19.6-darwin-arm64/bin/node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"`.

- [ ] **Step 4: Complete merge commit**

---

### Task 5: Harden escAttr() in pages/admin.html

**Files:** Modify: `pages/admin.html` (function at ~line 1566 post-merge — locate with `grep -n "function escAttr" pages/admin.html`).

Background: `esc()` (textContent→innerHTML) encodes `&<>` but NOT quotes. `escAttr()` output is interpolated into double-quoted `onclick="fn('<val>')"` attributes; a literal `"` in the value escapes the attribute. Current:

```js
function escAttr(s){return esc(String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"'));}
```

- [ ] **Step 1: Write the failing check** — create `tests/esc-attr.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function extractEscAttr() {
  const html = readFileSync(new URL('../pages/admin.html', import.meta.url), 'utf8');
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const m = html.match(/function escAttr\(s\)\{[^\n]*\}/);
  if (!m) throw new Error('escAttr not found');
  // eslint-disable-next-line no-new-func
  return new Function('esc', `${m[0]}; return escAttr;`)(esc);
}

describe('escAttr', () => {
  it('entity-encodes double quotes so values cannot break out of a double-quoted attribute', () => {
    const escAttr = extractEscAttr();
    expect(escAttr('a"b')).not.toContain('"');
  });
  it('entity-encodes single quotes', () => {
    const escAttr = extractEscAttr();
    expect(escAttr("a'b")).not.toContain("'");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (`…vitest.mjs run tests/esc-attr.test.js`) — current escAttr leaves raw `\"` (contains `"`).

- [ ] **Step 3: Implement** — replace the function line with:

```js
function escAttr(s){return esc(String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"')).replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
```

(Entity-encoding happens AFTER esc(), so `&` from esc's output is not double-encoded by these two replaces — they only touch quote chars.)

- [ ] **Step 4: Run the test, expect PASS; run full suite, all pass.**

- [ ] **Step 5: Commit** — `git add pages/admin.html tests/esc-attr.test.js && git commit -m "Harden escAttr: entity-encode quotes against attribute breakout"`

---

### Task 6: Consolidate grey tokens in pages/admin.html

**Files:** Modify: `pages/admin.html` `:root` block (~line 15–26 of the `<style>`).

- [ ] **Step 1: Make `--line` an alias of `--border`** (both are `#e5e8ef`; `--border` stays the source of truth). Change

```css
--bg:#f6f7f9;--panel:#fff;--line:#e5e8ef;--text:#0f172a;--muted:#64748b;--ink:#0f172a;
```

to

```css
--bg:#f6f7f9;--panel:#fff;--line:var(--border);--text:#0f172a;--muted:#64748b;--ink:#0f172a;
```

Note: CSS custom properties resolve at use time, so `--line` referencing `--border` defined later in the same `:root` block is valid.

- [ ] **Step 2: Verify** — `grep -c "var(--line)" pages/admin.html` unchanged from before the edit; exactly one definition each of `--line:` and `--border:`. Full vitest run passes.

- [ ] **Step 3: Commit** — `git commit -am "Consolidate grey tokens: --line aliases --border"`

---

### Task 7: Tokenize hardcoded box-shadows in pages/admin.html

**Files:** Modify: `pages/admin.html` `<style>` block only (NOT JS-generated inline styles).

- [ ] **Step 1: Add tokens** to the `:root` line that defines `--shadow`/`--shadow-lg` (~line 26):

```css
--shadow:0 1px 2px rgba(15,23,42,.05);--shadow-sm:0 2px 8px rgba(15,23,42,.06);--shadow-md:0 4px 16px rgba(0,0,0,.12);--shadow-pop:0 8px 24px rgba(15,23,42,.12);--shadow-modal:0 20px 60px rgba(0,0,0,.3);--focus-ring:0 0 0 3px rgba(79,70,229,.08);--shadow-lg:0 20px 50px -12px rgba(0,0,0,.3);
```

- [ ] **Step 2: Replace hardcoded values in the `<style>` block** with the nearest token, exact mapping:
  - `0 4px 16px rgba(0,0,0,.12)` → `var(--shadow-md)`
  - `0 0 0 3px rgba(79,70,229,.08)` and `0 0 0 3px rgba(79,70,229,.06)` → `var(--focus-ring)`
  - `0 0 0 2px rgba(79,70,229,.12)` / `.18` → leave (input focus weights, distinct by design) OR map all to `var(--focus-ring)` only if visually identical weight — default: leave.
  - `0 2px 8px rgba(15,23,42,.06)`, `0 2px 8px rgba(0,0,0,.06)`, `0 2px 10px rgba(15,23,42,.07)` → `var(--shadow-sm)`
  - `0 4px 12px rgba(15,23,42,.08)` → `var(--shadow-md)`
  - `0 8px 24px rgba(15,23,42,.12)`, `0 8px 24px rgba(0,0,0,.15)` → `var(--shadow-pop)`
  - `0 20px 60px rgba(0,0,0,.3)`, `0 20px 60px rgba(0,0,0,.4)`, `0 20px 50px rgba(0,0,0,.3)` → `var(--shadow-modal)`
  - `0 1px 3px rgba(0,0,0,.1)` → `var(--shadow)`
  - `box-shadow:none` → leave.

- [ ] **Step 3: Verify** — `grep -o "box-shadow:[^;}]*" pages/admin.html | grep -v "var(--" | grep -v none` inside the `<style>` block returns only the deliberately-left focus weights; full vitest run passes.

- [ ] **Step 4: Commit** — `git commit -am "Tokenize admin box-shadows onto shadow scale"`

---

### Task 8: Typography token scale (--fs-*) in pages/admin.html

**Files:** Modify: `pages/admin.html` `<style>` block only.

- [ ] **Step 1: Add scale** to `:root`:

```css
--fs-2xs:10px;--fs-xs:11px;--fs-sm:12px;--fs-md:13px;--fs-base:14px;--fs-lg:16px;--fs-xl:18px;--fs-2xl:22px;
```

- [ ] **Step 2: Replace within the `<style>` block only** (do NOT touch `<script>` content):
  - `font-size:10px` → `font-size:var(--fs-2xs)`; `11px` → `var(--fs-xs)`; `12px` → `var(--fs-sm)`; `13px` → `var(--fs-md)`; `14px` → `var(--fs-base)`; `16px` → `var(--fs-lg)`; `18px` → `var(--fs-xl)`; `22px` → `var(--fs-2xl)`.
  - Strays normalize: `9px`→`var(--fs-2xs)`, `10.5px`→`var(--fs-xs)`, `12.5px`→`var(--fs-md)`, `0.7rem`→`var(--fs-xs)`, `0.75rem`→`var(--fs-sm)`, `0.8rem`→`var(--fs-md)`, `0.85rem`→`var(--fs-base)`, `0.9rem`→`var(--fs-base)`.
  - Display sizes (15px, 32-48px) left as-is (one-offs).
  Use a small node script that splits the file at the `<style>`/`</style>` boundaries and applies replacements only inside, to guarantee `<script>` blocks are untouched.

- [ ] **Step 3: Verify** — inside `<style>`: `grep -c "font-size:1[0-4]px"` ≈ 0; JS block byte-identical (`git diff` shows changes only between `<style>` tags); full vitest run passes.

- [ ] **Step 4: Commit** — `git commit -am "Add --fs-* typography scale to admin, normalize stray sizes"`

---

### Task 9: Fix stale CLAUDE.md visa note

**Files:** Modify: `CLAUDE.md` (Registration Flow section).

- [ ] **Step 1: Replace the "Visa application step is deferred" paragraph** with a note that the Visa step was re-enabled 2026-05-12 (see `docs/deferred-visa-application.md` for history), and add Visa back into the flow line if absent.

- [ ] **Step 2: Commit** — `git commit -am "docs: CLAUDE.md — visa step is live again (re-enabled 2026-05-12)"`

---

### Task 10: Final verification + preview deploy (MAIN SESSION ONLY)

- [ ] **Step 1: Full suite** — `/tmp/node-v20.19.6-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run` → all pass; `node --check server.js` → OK.

- [ ] **Step 2: Push the branch** (main session, never a subagent):

```bash
git push -u origin worktree-unified-preview
```

Expected: Vercel git integration auto-creates a preview deployment for `worktree-unified-preview`. Main is untouched.

- [ ] **Step 3: Report** — list merged branches, completion commits, test counts, and the preview branch name; note that admin login on the preview uses the preview host scope and requires the Preview-env vars already configured.
