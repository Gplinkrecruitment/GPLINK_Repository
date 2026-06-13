# Admin Dashboard Bug Fix + UI Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three JS bug classes in `pages/admin.html` and normalize its visual system (tokens, buttons, cards, modals, breakpoints) without renaming any class used by JS-generated markup, then ship as a preview branch.

**Architecture:** Single-file change set — `pages/admin.html` only. Bug fixes follow patterns already in the file (`escAttr()`, guarded `JSON.parse`). Visual cleanup happens inside the `<style>` block (lines ~12–1274) and static HTML (lines ~1278–1474) by routing values through an expanded `:root` token set; JS-generated markup is untouched except for the escaping fix.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework, no build step). Verification: `node --check` on the extracted inline script, `npx vitest run`, grep assertions.

**Verification note (replaces TDD):** There is no test harness for this HTML page. Every task verifies via: (1) extract inline script and `node --check` it, (2) grep assertions proving the transformation happened, (3) `npx vitest run` still green. Extract-and-check command used throughout:

```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('pages/admin.html','utf8');
const m=html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if(!m){console.error('script block not found');process.exit(1)}
fs.writeFileSync('/tmp/admin-inline.js',m[1]);
" && node --check /tmp/admin-inline.js && echo SYNTAX-OK
```

(If the regex misses because there are multiple `<script>` blocks, extract the LAST inline block — the one containing `"use strict"` at ~line 1475.)

---

### Task 1: Escape `task.id` in inline event-handler strings

**Files:**
- Modify: `pages/admin.html` lines 1701, 1702, 1717, 1744–1747, 1762, 1789–1792, 1807

The file already has `escAttr()` and uses it correctly in sibling branches (lines 1707–1708, 1751–1752, 1796–1797). These 13 spots concatenate raw `task.id` into `onclick`/`onchange` attribute strings.

- [ ] **Step 1: Count the unsafe pattern before editing**

```bash
grep -c "+ task.id + '\\\\''" pages/admin.html
```
Expected: 13

- [ ] **Step 2: Replace every unsafe occurrence**

Each occurrence has the exact shape `\'' + task.id + '\')` inside a handler-attribute string. Replace `task.id` with `escAttr(task.id)` in ALL of them. Examples of the exact before/after:

Line 1701:
```js
// before
'<button class="btn-action btn-review" onclick="openPDEditor(\'' + task.id + '\')">Edit & Review</button>' +
// after
'<button class="btn-action btn-review" onclick="openPDEditor(\'' + escAttr(task.id) + '\')">Edit & Review</button>' +
```

Line 1717 (onchange variant):
```js
// before
pdHtml += '<div class="doc-task-actions"><label class="btn-action btn-upload">Upload File<input type="file" accept=".pdf,.doc,.docx" onchange="uploadTaskDoc(\'' + task.id + '\',this)"></label></div>';
// after
pdHtml += '<div class="doc-task-actions"><label class="btn-action btn-upload">Upload File<input type="file" accept=".pdf,.doc,.docx" onchange="uploadTaskDoc(\'' + escAttr(task.id) + '\',this)"></label></div>';
```

Apply identically at: 1701, 1702, 1717, 1744, 1745, 1746, 1747, 1762, 1789, 1790, 1791, 1792, 1807. Do NOT touch lines already using `escAttr(task.id)`.

- [ ] **Step 3: Verify**

```bash
grep -c "+ task.id + '\\\\''" pages/admin.html        # expected: 0
grep -c "escAttr(task.id)" pages/admin.html            # expected: >= 19 (6 pre-existing + 13 new)
```
Then run the extract-and-check command (SYNTAX-OK) and `npx vitest run` (all green).

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html && git commit -m "Escape task.id in inline event handler strings"
```

---

### Task 2: Guard `JSON.parse` in timeline merge

**Files:**
- Modify: `pages/admin.html` line ~3087 (inside `mergeTimelineData`)

- [ ] **Step 1: Apply the guarded-parse pattern**

```js
// before (lines 3085-3089)
      var attachInfo=null;
      if(m.attachments){
        var att=typeof m.attachments==='string'?JSON.parse(m.attachments||'[]'):m.attachments;
        if(Array.isArray(att)&&att.length)attachInfo=att.length+' attachment'+(att.length>1?'s':'');
      }
// after
      var attachInfo=null;
      if(m.attachments){
        var att=m.attachments;
        if(typeof att==='string'){try{att=JSON.parse(att||'[]');}catch(_e){att=[];}}
        if(Array.isArray(att)&&att.length)attachInfo=att.length+' attachment'+(att.length>1?'s':'');
      }
```

- [ ] **Step 2: Verify** — extract-and-check (SYNTAX-OK), `npx vitest run` green.

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html && git commit -m "Guard timeline attachments JSON.parse against malformed data"
```

---

### Task 3: Resilient event binding with `on()` helper

**Files:**
- Modify: `pages/admin.html` — helper near other helpers (~line 1530, after `escAttr`/`safeUrl` definitions); call sites are every `document.getElementById("...").addEventListener(` occurrence.

One missing element currently throws and kills every subsequent binding in the same block. Add a guard helper and route bindings through it.

- [ ] **Step 1: Add the helper**

Immediately after the existing `escAttr` function definition (grep `function escAttr` to locate), insert:

```js
  function on(id,evt,fn){var el=document.getElementById(id);if(el)el.addEventListener(evt,fn);return el;}
```

- [ ] **Step 2: Convert call sites**

```bash
grep -n 'document\.getElementById("[A-Za-z0-9_]*")\.addEventListener(' pages/admin.html
```

For every hit, mechanically rewrite:
`document.getElementById("X").addEventListener("EVT",HANDLER)` → `on("X","EVT",HANDLER)` — the handler body (including multiline arrow functions) is unchanged. Known sites include lines ~3866, 3871, 3893, 5483, 5577, 5646, 5647, 5707, 6154, 6260 plus any others the grep finds. Do NOT convert `document.addEventListener(...)` (no id) or cases where the element reference is reused afterwards (check the next ~3 lines; if the same `getElementById` result is captured in a variable, leave it).

- [ ] **Step 3: Verify**

```bash
grep -c 'document\.getElementById("[A-Za-z0-9_]*")\.addEventListener(' pages/admin.html   # expected: 0
grep -c 'function on(id,evt,fn)' pages/admin.html                                          # expected: 1
```
Extract-and-check (SYNTAX-OK), `npx vitest run` green.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html && git commit -m "Add null-safe on() helper for event bindings"
```

---

### Task 4: Design tokens + invalid value fixes

**Files:**
- Modify: `pages/admin.html` `<style>` block only (between `<style>` at ~line 12 and `</style>` at ~line 1275). NEVER touch anything after `</style>`.

- [ ] **Step 1: Expand `:root`**

Replace the existing single-line `:root{...}` (line 13) with (existing variable names MUST all be preserved — other rules reference them):

```css
    :root{
      /* brand + status */
      --bg:#f4f6fb;--panel:#fff;--line:#dfe6f2;--text:#0f172a;--muted:#64748b;
      --blue:#2563eb;--blue-dark:#1d4ed8;--blue-bg:#eff6ff;
      --green:#16a34a;--green-bg:#f0fdf4;
      --amber:#b45309;--amber-bg:#fffbeb;
      --red:#dc2626;--red-bg:#fef2f2;
      --purple-1:#7c3aed;--purple-2:#6366f1;--accent:#4f46e5;
      /* surfaces */
      --bg2:#f8fafc;--bg3:#e2e8f0;--border:#dfe6f2;--surface:#f1f5f9;
      /* radii */
      --radius:12px;--r-sm:6px;--r-md:8px;--r-full:999px;
      /* shadows */
      --shadow:0 1px 3px rgba(15,23,42,.08);--shadow-lg:0 20px 60px rgba(15,23,42,.25);
    }
```

- [ ] **Step 2: Fix invalid font-weights (style block only)**

```bash
# inspect first
grep -n 'font-weight:7[0-9][0-9]\|font-weight:8[0-9][0-9]' pages/admin.html | head -40
```
Within the style block: `font-weight:760` → `font-weight:700`; `font-weight:850` → `font-weight:800`. Leave 500/600/700/800/900 alone.

- [ ] **Step 3: Unify breakpoints and transitions (style block only)**

- `@media(max-width:600px)` → `@media(max-width:640px)`
- `@media(max-width:700px)` → `@media(max-width:640px)`
- `transition:all .12s` → `transition:all .15s` (and any other `.12s` durations → `.15s`)

- [ ] **Step 4: Normalize pill radii**

In the style block: `border-radius:99px` → `border-radius:var(--r-full)`; `border-radius:999px` → `border-radius:var(--r-full)`.

- [ ] **Step 5: Verify**

```bash
awk '/<\/style>/{exit} {print}' pages/admin.html | grep -c 'font-weight:760\|font-weight:850'   # 0
awk '/<\/style>/{exit} {print}' pages/admin.html | grep -c 'max-width:600px\|max-width:700px'   # 0
grep -c -- '--r-full' pages/admin.html    # >= 3
```
Extract-and-check (SYNTAX-OK — proves the HTML structure wasn't broken), `npx vitest run` green.

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html && git commit -m "Add design token system, fix invalid font weights, unify breakpoints"
```

---

### Task 5: Route hardcoded colors through tokens (style block only)

**Files:**
- Modify: `pages/admin.html` `<style>` block ONLY. Do not change colors in JS strings or HTML `style=` attributes (separate task handles static HTML).

- [ ] **Step 1: Apply this exact substitution map inside the style block**

All replacements are value-identical to a token, so rendering cannot change:

| hardcoded | replace with |
|---|---|
| `#2563eb` | `var(--blue)` |
| `#1d4ed8` | `var(--blue-dark)` |
| `#eff6ff` | `var(--blue-bg)` |
| `#16a34a` | `var(--green)` |
| `#f0fdf4` | `var(--green-bg)` |
| `#b45309` | `var(--amber)` |
| `#fffbeb` | `var(--amber-bg)` |
| `#dc2626` | `var(--red)` |
| `#fef2f2` | `var(--red-bg)` |
| `#f8fafc` | `var(--bg2)` |
| `#e2e8f0` | `var(--bg3)` |
| `#f1f5f9` | `var(--surface)` |
| `#dfe6f2` | `var(--line)` |
| `#64748b` | `var(--muted)` |
| `#0f172a` | `var(--text)` |
| `#7c3aed` | `var(--purple-1)` |
| `#6366f1` | `var(--purple-2)` |
| `#4f46e5` | `var(--accent)` |

EXCEPTIONS — do not substitute inside the `:root{}` block itself (the definitions), and do not substitute inside `var(--x, FALLBACK)` fallback positions (a var() fallback may not itself contain the var being defined; substituting other vars there is allowed but skip it for simplicity — leave all existing `var(--x,#hex)` fallbacks untouched).

Implementation hint: operate on the style-block line range only (find `</style>` line first), e.g. with a small Node script or careful `sed -i '' '13,RANGEs/.../.../g'`. Case-insensitive hex match (`#2563EB` ≡ `#2563eb`).

- [ ] **Step 2: Also align stray `var()` fallbacks that disagree**

`color:var(--muted,#666)` vs `color:var(--muted,#9aa3b2)` — normalize all `var(--muted,#666)` and `var(--muted,#9aa3b2)` to plain `var(--muted)` (the token is always defined in `:root`, fallbacks are dead weight). Same for any `var(--X,#hex)` where `--X` is defined in `:root`: strip the fallback. This applies in the style block only.

- [ ] **Step 3: Verify**

```bash
# counts in style block should drop dramatically (was ~367 hardcoded-color lines)
awk '/<\/style>/{exit} {print}' pages/admin.html | grep -c '#2563eb\|#1d4ed8\|#f8fafc\|#f1f5f9'   # expected: 0
awk '/<\/style>/{exit} {print}' pages/admin.html | grep -c 'var(--muted,#'                          # expected: 0
```
Extract-and-check (SYNTAX-OK), `npx vitest run` green.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html && git commit -m "Route style-block colors through design tokens"
```

---

### Task 6: Component base rules (buttons, cards, modals) — no renames

**Files:**
- Modify: `pages/admin.html` `<style>` block only.

Insert base rules EARLY in the style block (right after the `:root` block) so later per-class rules still win the cascade. Then remove only declarations that became exact duplicates.

- [ ] **Step 1: Insert shared base rules after `:root`**

```css
    /* component bases — shared geometry; per-class rules keep color intent */
    .btn,.btn-action,.filter-btn,.tech-filter-btn,.support-filter-btn,.tools-subnav-btn,
    .tech-subnav-btn,.mc-subnav-btn,.guide-add-btn,.guide-mgmt-btn,.st-primary-btn,
    .st-nudge-btn,.st-more-btn,.ops-btn-secondary,.ops-btn-green,.ops-btn-danger,
    .ops-btn-sm,.btn-generate,.btn-review,.btn-submit,.btn-upload,.btn-mailto,
    .doc-upload-btn,.drive-upload-btn,.mc-explore-btn,.gp-task-complete-btn,.back-btn{
      font-family:inherit;font-size:12px;font-weight:600;line-height:1.2;
      border-radius:var(--r-md);cursor:pointer;transition:all .15s ease;
    }
    .case-card,.app-admin-card,.iv-card,.ticket-card,.mc-card,.gp-card,.tech-card,
    .agent-card,.agent-run-card,.ai-summary-card,.call-history-card,.note-card,
    .todo-card,.integration-card,.els-admin-card,.drive-file-card,.zoom-task-card{
      background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
    }
    .modal,.zoom-modal{border-radius:16px;box-shadow:var(--shadow-lg);background:var(--panel);}
```

IMPORTANT pre-check: before inserting, grep each class name exists in the file (`grep -c '\.case-card{' pages/admin.html` style spot checks). If a listed class does not exist, drop it from the group. If an existing per-class rule sets a DIFFERENT font-size (e.g. `.btn` is 13px), the later rule wins — that is fine and intended; the base only standardizes classes that didn't specify.

- [ ] **Step 2: Remove now-duplicate declarations**

For each class in the card group, if its own rule contains exactly `background:var(--panel)`, `border:1px solid var(--line)`, and/or `border-radius:var(--radius)` (post-Task-5 values), delete those declarations from the per-class rule (leave the rest — padding etc. — alone). ONLY delete exact matches. If unsure, leave it — duplicates are harmless.

- [ ] **Step 3: Verify**

```bash
grep -c 'component bases' pages/admin.html   # 1
```
Extract-and-check (SYNTAX-OK), `npx vitest run` green. Then render check: `npm start` in background, `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/pages/admin.html` (200 or auth redirect 302 both acceptable), kill server.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html && git commit -m "Add shared component base rules for buttons, cards, modals"
```

---

### Task 7: Readability formatting of monster CSS lines

**Files:**
- Modify: `pages/admin.html` `<style>` block only.

- [ ] **Step 1: Break the worst single-line rule clusters into one-rule-per-line**

Targets (locate by grep, line numbers have shifted): the stage-pill cluster (`.stage-myintealth{...}.stage-amc{...}` — 8 rules on one line), the task-badge cluster (`.task-badge.urgent{...}` etc.), and every `@media(...)` block that contains multiple rules on one line (grep `@media`). Formatting only — identical declarations, one rule per line, no value changes.

- [ ] **Step 2: Verify** — extract-and-check (SYNTAX-OK), `npx vitest run` green, and:

```bash
git diff --word-diff=porcelain pages/admin.html | grep -c '^[+-][^+-]' # whitespace-dominant diff; spot-check `git diff` manually for any value change
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html && git commit -m "Format multi-rule CSS lines for readability"
```

---

### Task 8: Static-markup inline-style cleanup

**Files:**
- Modify: `pages/admin.html` static HTML between `</style>` (~line 1276) and the final `<script>` open tag (~line 1475) ONLY. JS-generated markup is out of bounds.

- [ ] **Step 1: Add utility classes at the end of the style block (before `</style>`)**

```css
    /* static-markup utilities */
    .panel-title{margin:0 0 6px;}
    .panel-sub{color:var(--muted);margin:0 0 16px;font-size:13px;}
    .hint{font-size:12px;color:var(--muted);margin:4px 0 4px 16px;}
```

- [ ] **Step 2: Convert repeated inline styles in the static section**

Grep `style="` within the static line range. For each element whose inline style exactly matches a utility above (e.g. `<h2 style="margin:0 0 6px">` → `<h2 class="panel-title">`, `<p style="color:var(--muted);margin:0 0 16px;font-size:13px">` → `<p class="panel-sub">`), swap to the class. Leave `style="display:none"` and any one-off styles ALONE (visibility toggles are JS-controlled).

- [ ] **Step 3: Verify** — extract-and-check (SYNTAX-OK), `npx vitest run` green, and confirm zero changes outside the static range: `git diff -U0 pages/admin.html | grep '^@@'` hunks all fall in the static range or style block.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html && git commit -m "Replace repeated static inline styles with utility classes"
```

---

### Task 9: Full verification pass

- [ ] **Step 1: Syntax + tests**

```bash
node -e "...extract..." && node --check /tmp/admin-inline.js   # SYNTAX-OK
npx vitest run                                                  # all green
```

- [ ] **Step 2: Serve and smoke-test**

```bash
npm start &   # background
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/pages/admin.html
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/admin
kill %1
```
Expected: 200 and/or auth redirect (302/401) — NOT 500.

- [ ] **Step 3: Confirm no stray edits**

```bash
git status --short    # only pages/admin.html + docs files
git log --oneline origin/main..HEAD
```

---

### Task 10: Push branch + preview deploy (NOT production)

- [ ] **Step 1:** `git push -u origin worktree-admin-dashboard-cleanup`
- [ ] **Step 2:** Preview deploy via Vercel (`vercel` — no `--prod` flag). Capture preview URL.
- [ ] **Step 3:** Report preview URL. Do NOT merge to main, do NOT promote.
