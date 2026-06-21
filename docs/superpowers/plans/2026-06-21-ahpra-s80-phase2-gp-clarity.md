# AHPRA s80 — Phase 2: GP Clarity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the doctor's AHPRA "more information" page clear at a glance — overall progress, a deadline countdown, an at-a-glance status chip per item, and read-only visibility of the items the team is handling.

**Architecture:** Build on Phase 1 (already merged to this branch). Two files: extend the GP-facing endpoint `GET /api/ahpra/more-info` in `server.js` to also return team-owned items as read-only summaries, and enhance the GP card render in `pages/ahpra.html`. All data already lives in `registration_tasks.metadata` — **no migration**. New display logic is added as small **pure JS helpers** so they can be runtime-verified.

**Tech Stack:** Node.js (`server.js`), vanilla inline JS (`pages/ahpra.html`). No automated UI test harness exists; pure helpers are verified by extracting and running them with a temporary Node; the endpoint is verified by `node --check` + review; UX is verified manually and reported as manual.

**Spec:** `docs/superpowers/specs/2026-06-21-ahpra-s80-improvements-design.md` (Part D).

## Global Constraints

- **Plain-English, doctor-facing copy** — no jargon, no officer's raw legal wording.
- **Never expose the officer's verbatim text to the GP.** Team-item summaries are **title only** (no `detail`).
- **No database migration** — read existing `metadata`.
- **Backward compatible** — items/notices created before Phase 1 may lack `ai_*` fields and team items; all new rendering must no-op gracefully on missing/empty data.
- **Escape all interpolated text** with the page's existing `s80Esc(...)` before putting it in HTML.
- **Scope:** Phase 2 does **not** add the CC banner (moved to Phase 3, which builds the assigned-RSO address lookup it needs) and does **not** add a "Confirmed received" status (that needs Phase 3's `received_confirmed_at`). Request items terminate at "Requested — awaiting AHPRA" for now.
- **Commit after each task; do NOT push from subagents** (the controller pushes). Verify with the temporary Node at `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node` (already downloaded this session) — there is no system Node.

---

## File structure (Phase 2)

- **Modify** `server.js` — in `GET /api/ahpra/more-info`, collect active team-owned s80 items (excluding the internal combined-reply task and unparsed items) into a `team_items` array and add it to the JSON response.
- **Modify** `pages/ahpra.html` — add pure helpers `s80DaysLeft`, `s80ProgressCount`, `s80StatusChip`; render a progress bar + deadline countdown in `renderAhpraMoreInfoCard`; add a per-item status chip in `ahpraMoreInfoItemHtml`; render a read-only "Handled by our team" section from `data.team_items` (replacing the static footer note).

---

### Task 1: Return team-handled items (read-only) from the GP endpoint

**Files:**
- Modify: `server.js` — `GET /api/ahpra/more-info` handler (the block starting `if (pathname === '/api/ahpra/more-info' && req.method === 'GET') {`)

**Interfaces:**
- Produces: the JSON response gains `team_items: Array<{ id: string, title: string, kind: string }>` — active, team-owned s80 items, excluding `mode==='reply'`, `kind==='needs_split'`, and cancelled tasks. Title only (never `detail`). Task 3 (GP page) consumes `data.team_items`.

- [ ] **Step 1: Add the `s80TeamItems` collection**

In `server.js`, find the line `const s80Items = [];` inside the `/api/ahpra/more-info` handler. Immediately AFTER it, add:

```js
    const s80TeamItems = [];
```

- [ ] **Step 2: Collect team items inside the existing loop**

In the same handler, the per-task callback begins and then has the guard line:
```js
      if (!m.s80 || m.review_status !== 'active' || m.owner !== 'gp') return;
```
Immediately **BEFORE** that guard line, add the team-item collection (it must run before the GP-only `return`):

```js
      if (m.s80 && m.review_status === 'active' && m.owner === 'team'
          && m.mode !== 'reply' && m.kind !== 'needs_split' && t.status !== 'cancelled') {
        s80TeamItems.push({ id: t.id, title: t.title || '', kind: m.kind || '' });
      }
```

- [ ] **Step 3: Add `team_items` to the response**

Find the response line:
```js
    sendJson(res, 200, { ok: true, reference: s80Reference, deadline: s80Deadline, items: s80Items });
```
Change it to:
```js
    sendJson(res, 200, { ok: true, reference: s80Reference, deadline: s80Deadline, items: s80Items, team_items: s80TeamItems });
```

> Note: there are TWO other early `sendJson(res, 200, { ok: true, items: [], deadline: null });` returns in this handler (for no-user / no-case). Leave those as-is — a missing `team_items` is treated as empty by the page.

- [ ] **Step 4: Verify syntax**

Run (from the worktree):
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo "server.js OK"
grep -n "s80TeamItems" server.js
```
Expected: `server.js OK`; `s80TeamItems` appears exactly 3 times (declare, push, response).

- [ ] **Step 5: Commit (do NOT push)**

```bash
git add server.js
git commit -m "AHPRA s80: return team-handled items (read-only) from GP more-info endpoint"
```

---

### Task 2: Progress tracker + deadline countdown on the GP card

**Files:**
- Modify: `pages/ahpra.html` — add helpers near `s80FormatDate` (~line 4314); enhance `renderAhpraMoreInfoCard` (~line 4387)

**Interfaces:**
- Consumes: `data.items` (each has `status`) and `data.deadline` (`'YYYY-MM-DD'|null`).
- Produces: pure helpers `s80DaysLeft(deadline)` and `s80ProgressCount(items)` (used by the card; also used implicitly by Task 3's design but not required by it).

- [ ] **Step 1: Add the two pure helpers**

In `pages/ahpra.html`, immediately AFTER the `s80FormatDate` function (it ends a few lines below `function s80FormatDate(d) {`), add:

```js
    // Whole days from today (local) until the deadline; null if no/invalid date.
    function s80DaysLeft(deadline) {
      if (!deadline) return null;
      var d = new Date(deadline + 'T00:00:00');
      if (isNaN(d.getTime())) return null;
      var now = new Date();
      var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return Math.round((d - today) / 86400000);
    }
    // Count GP-actionable items that are finished (uploaded+accepted, or marked requested).
    function s80ProgressCount(items) {
      var done = 0, list = items || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].status === 'approved' || list[i].status === 'requested') done++;
      }
      return { done: done, total: list.length };
    }
```

- [ ] **Step 2: Run the failing helper checks (red)**

Create `$CLAUDE_JOB_DIR/tmp/verify-phase2-helpers.cjs`:

```js
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
function extract(name){
  const start = html.indexOf('function ' + name + '(');
  if(start < 0) throw new Error('not found: ' + name);
  let i = html.indexOf('{', start), depth = 0, end = -1;
  for(; i < html.length; i++){ if(html[i]==='{')depth++; else if(html[i]==='}'){depth--; if(depth===0){end=i+1;break;}} }
  return html.slice(start, end);
}
const src = extract('s80DaysLeft') + '\n' + extract('s80ProgressCount');
const factory = new Function(src + '\nreturn { s80DaysLeft, s80ProgressCount };');
const { s80DaysLeft, s80ProgressCount } = factory();
let pass=0, fail=0; const ok=(n,c)=>{ c?pass++:(fail++,console.log('FAIL',n)); };
ok('null deadline -> null', s80DaysLeft(null) === null);
ok('progress counts approved+requested', (function(){ var p=s80ProgressCount([{status:'approved'},{status:'requested'},{status:'todo'},{status:'under_review'}]); return p.done===2 && p.total===4; })());
ok('progress empty', (function(){ var p=s80ProgressCount([]); return p.done===0 && p.total===0; })());
ok('progress undefined-safe', (function(){ var p=s80ProgressCount(undefined); return p.done===0 && p.total===0; })());
console.log('RESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail?1:0);
```

Run: `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node "$CLAUDE_JOB_DIR/tmp/verify-phase2-helpers.cjs" "$(pwd)/pages/ahpra.html"`
Expected after Step 1: PASS (4/4). (If you run this BEFORE Step 1, it throws "not found" — that is the red state.)

- [ ] **Step 3: Render progress + countdown in `renderAhpraMoreInfoCard`**

In `renderAhpraMoreInfoCard`, replace the existing `deadlineHtml` block. The current code is:

```js
      var deadlineHtml = '';
      if (data.deadline) {
        deadlineHtml = '<div style="margin-top:14px;padding:10px 14px;border-radius:10px;background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.2);color:var(--gp-red,#dc2626);font-size:13px;font-weight:600;text-align:center;">Please action these by ' + s80Esc(s80FormatDate(data.deadline)) + '</div>';
      }
      var itemsHtml = data.items.map(ahpraMoreInfoItemHtml).join('');
```

Replace it with (adds countdown wording + colour escalation, and a progress bar):

```js
      var deadlineHtml = '';
      if (data.deadline) {
        var dl = s80DaysLeft(data.deadline);
        var when = s80Esc(s80FormatDate(data.deadline));
        var dlText = (dl === null) ? ('Please action these by ' + when)
          : (dl < 0) ? ('Overdue — was due ' + when)
          : (dl === 0) ? ('Due today — ' + when)
          : (dl + ' day' + (dl === 1 ? '' : 's') + ' left — due ' + when);
        var urgent = (dl !== null && dl <= 3);
        var dBg = urgent ? 'rgba(220,38,38,0.08)' : 'rgba(245,158,11,0.10)';
        var dBd = urgent ? 'rgba(220,38,38,0.2)' : 'rgba(245,158,11,0.25)';
        var dFg = urgent ? 'var(--gp-red,#dc2626)' : 'var(--gp-amber-ink,#b45309)';
        deadlineHtml = '<div style="margin-top:14px;padding:10px 14px;border-radius:10px;background:' + dBg + ';border:1px solid ' + dBd + ';color:' + dFg + ';font-size:13px;font-weight:600;text-align:center;">' + dlText + '</div>';
      }
      var prog = s80ProgressCount(data.items);
      var progressHtml = '';
      if (prog.total) {
        var pctDone = Math.round(prog.done / prog.total * 100);
        progressHtml = '<div style="max-width:440px;margin:14px auto 0;">'
          + '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--ink-muted);margin-bottom:4px;">'
          + '<span>' + prog.done + ' of ' + prog.total + ' done</span><span>' + pctDone + '%</span></div>'
          + '<div style="height:8px;border-radius:6px;background:var(--border);overflow:hidden;">'
          + '<div style="height:100%;width:' + pctDone + '%;background:var(--gp-green-ink,#15803d);transition:width .3s;"></div></div></div>';
      }
      var itemsHtml = data.items.map(ahpraMoreInfoItemHtml).join('');
```

Then, in the same function's big `return '<div ...>' + ... ` concatenation, insert `progressHtml` immediately AFTER `deadlineHtml +`:

```js
        deadlineHtml +
        progressHtml +
        '<div id="ahpraMoreInfoList" style="margin-top:18px;display:flex;flex-direction:column;gap:12px;">' + itemsHtml + '</div>' +
```

- [ ] **Step 4: Re-run the helper checks (green) + syntax-sanity the render**

Run the same command from Step 2 — expected PASS (4/4). The render function isn't a pure helper, so confirm by reading `git diff` that: `deadlineHtml` block replaced cleanly, `progressHtml` defined and inserted once after `deadlineHtml +`, all string concatenation is balanced.

- [ ] **Step 5: Commit (do NOT push)**

```bash
git add pages/ahpra.html
git commit -m "AHPRA s80 (GP): add progress tracker + deadline countdown to the more-info card"
```

---

### Task 3: Per-item status chip + read-only team-items section

**Files:**
- Modify: `pages/ahpra.html` — add helper `s80StatusChip` near the others; use it in `ahpraMoreInfoItemHtml` (~line 4337); render team section in `renderAhpraMoreInfoCard` (~line 4387)

**Interfaces:**
- Consumes: `item.status` (per GP item) and `data.team_items` (from Task 1).
- Produces: pure helper `s80StatusChip(item)`.

- [ ] **Step 1: Add the status-chip helper**

In `pages/ahpra.html`, immediately AFTER the `s80ProgressCount` function added in Task 2, add:

```js
    // Small at-a-glance status pill for a GP item.
    function s80StatusChip(item) {
      var map = {
        todo: ['To do', '#64748b', '#f1f5f9'],
        under_review: ['Under review', '#b45309', '#fef3c7'],
        approved: ['Done', '#15803d', '#dcfce7'],
        rejected: ['Action needed', '#b91c1c', '#fee2e2'],
        requested: ['Requested', '#15803d', '#dcfce7']
      };
      var s = map[item && item.status] || map.todo;
      return '<span style="font-size:10px;font-weight:700;color:' + s[1] + ';background:' + s[2] + ';border-radius:5px;padding:2px 7px;white-space:nowrap;">' + s[0] + '</span>';
    }
```

- [ ] **Step 2: Verify the chip helper (red→green)**

Append to `$CLAUDE_JOB_DIR/tmp/verify-phase2-helpers.cjs` BEFORE the RESULT line (or make a second file) checks for the chip — simplest is a second file `$CLAUDE_JOB_DIR/tmp/verify-chip.cjs`:

```js
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const start = html.indexOf('function s80StatusChip(');
let i = html.indexOf('{', start), depth=0, end=-1;
for(; i<html.length; i++){ if(html[i]==='{')depth++; else if(html[i]==='}'){depth--; if(depth===0){end=i+1;break;}} }
const factory = new Function(html.slice(start,end) + '\nreturn s80StatusChip;');
const chip = factory();
let pass=0, fail=0; const ok=(n,c)=>{ c?pass++:(fail++,console.log('FAIL',n)); };
ok('approved -> Done/green', chip({status:'approved'}).includes('Done') && chip({status:'approved'}).includes('#15803d'));
ok('rejected -> Action needed', chip({status:'rejected'}).includes('Action needed'));
ok('unknown -> To do', chip({status:'weird'}).includes('To do'));
ok('missing item -> To do', chip(undefined).includes('To do'));
console.log('RESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail?1:0);
```

Run: `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node "$CLAUDE_JOB_DIR/tmp/verify-chip.cjs" "$(pwd)/pages/ahpra.html"`
Expected: PASS (4/4).

- [ ] **Step 3: Show the chip in the item header**

In `ahpraMoreInfoItemHtml`, the return currently starts:

```js
      return '<div style="border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--surface-raised);">' +
        '<div style="font-weight:600;color:var(--ink);">' + s80Esc(item.title) + '</div>' +
```

Replace the title `<div>` line (the second line above) with a flex row carrying the title + chip:

```js
      return '<div style="border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--surface-raised);">' +
        '<div style="display:flex;align-items:flex-start;gap:8px;"><div style="font-weight:600;color:var(--ink);flex:1;">' + s80Esc(item.title) + '</div>' + s80StatusChip(item) + '</div>' +
```

- [ ] **Step 4: Render the read-only team section + remove the static footer note**

In `renderAhpraMoreInfoCard`, find the static footer note line:

```js
        '<p style="margin-top:18px;font-size:12px;color:var(--ink-muted);line-height:1.5;text-align:center;">Your supervised practice plan and qualification check are handled by our team — we will be in touch about those.</p>' +
```

Replace it with a dynamic team section (built just before the `return`, then referenced). First, immediately AFTER the `var itemsHtml = data.items.map(ahpraMoreInfoItemHtml).join('');` line, add:

```js
      var teamItems = data.team_items || [];
      var teamHtml = teamItems.length ? (
        '<div style="max-width:600px;margin:18px auto 0;">'
        + '<div style="font-size:12px;font-weight:700;color:var(--ink-muted);margin-bottom:8px;">Handled by our team</div>'
        + teamItems.map(function (t) {
            return '<div style="display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;background:var(--surface,#f8fafc);opacity:.9;">'
              + '<span style="font-size:13px;color:var(--ink-muted);">🛡️ ' + s80Esc(t.title) + '</span>'
              + '<span style="margin-left:auto;font-size:11px;color:var(--gp-green-ink,#15803d);font-weight:600;white-space:nowrap;">We’re handling this ✓</span>'
              + '</div>';
          }).join('')
        + '<div style="font-size:11px;color:var(--ink-muted);margin-top:2px;">No action needed from you on these — we’ll be in touch.</div>'
        + '</div>'
      ) : '';
```

Then replace the static footer `<p>...</p>` line in the `return` with:

```js
        teamHtml +
```

- [ ] **Step 5: Re-run both helper checks (green) + read the diff**

Run both verify commands (Task 2 Step 2 file and the chip file) — expected PASS. Read `git diff` to confirm: chip helper added once and called once in the item header; team section defined once and `teamHtml` referenced once in the return (static `<p>` note gone); concatenation balanced; `t.title` escaped via `s80Esc`.

- [ ] **Step 6: Manual verification (no UI harness — report as manual)**

Manually run `npm start`, open the AHPRA page for a GP with an active s80 notice (or log a test letter), hard-refresh, and confirm: progress bar + countdown show; each item has a status chip; team-handled items appear in a greyed "Handled by our team" section with no officer wording; an item-less/te­am-less state renders nothing extra and no console error.

- [ ] **Step 7: Commit (do NOT push)**

```bash
git add pages/ahpra.html
git commit -m "AHPRA s80 (GP): per-item status chip + read-only team-handled items section"
```

---

## Self-review (Phase 2 vs spec Part D)

- **Spec coverage:** progress tracker → Task 2; deadline countdown → Task 2; plain per-item statuses → Task 3 (chip) on top of existing per-state text; read-only team-item visibility → Task 1 (endpoint) + Task 3 (render). CC banner + "Confirmed received" status → explicitly deferred to Phase 3 (documented in Global Constraints) because they depend on Phase 3's RSO-address lookup and `received_confirmed_at`. ✓
- **Placeholder scan:** every step has concrete code + an exact verify command. ✓
- **Type consistency:** `team_items: [{id,title,kind}]` produced by Task 1 → consumed by Task 3 as `data.team_items` / `t.title`. `s80DaysLeft`/`s80ProgressCount`/`s80StatusChip` defined in Task 2/3 and used in the same file. `item.status` values (`todo`/`under_review`/`approved`/`rejected`/`requested`) match exactly what the GP endpoint sets. ✓
- **Safety:** all new renders no-op on empty/missing data (`prog.total` guard, `teamItems.length` guard, chip defaults to "To do"); all interpolation uses `s80Esc`. ✓
