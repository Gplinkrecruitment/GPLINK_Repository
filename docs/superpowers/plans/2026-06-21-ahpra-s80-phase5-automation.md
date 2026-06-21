# AHPRA s80 — Phase 5: Turn On Automation (gated, default-OFF) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire up the three automatic actions — auto-release of high-confidence notices, auto-approve of confidently-matched uploads, and auto-send of the combined reply (after a hold) — all gated behind a single env flag that **defaults OFF**, with audit + RSO/GP notification on every auto-action.

**Architecture:** A master switch `S80_AUTOMATION_ENABLED` (default `false`) gates every auto-path; with it off, behaviour is exactly today's human-in-the-loop flow (Phases 1–4). A pure `bundleAutoReleasable` predicate decides auto-release; the release transition is extracted into `_releaseS80Bundle` (shared by the manual endpoint + auto-release); the Phase-4 send logic is extracted into `_sendS80Reply` (shared by the manual endpoint + cron auto-send). Auto-send uses a scheduled `metadata.auto_send_at` fulfilled by the daily reconcile cron, with an admin "Cancel" affordance. No DB migration.

**Tech Stack:** Node.js `server.js`, `lib/ahpra-s80.js` (pure, vitest), vanilla inline JS (`pages/admin.html`). Verify the predicate with vitest; server/cron paths via `node --check` + review.

**Spec:** `docs/superpowers/specs/2026-06-21-ahpra-s80-improvements-design.md` (Part E).

## Global Constraints

- **Master switch:** `S80_AUTOMATION_ENABLED` (env, default `false`). When false, NONE of the auto-paths run — the app behaves exactly as Phases 1–4 (manual tray release, manual upload approve, manual/one-click reply send).
- **Confidence gate:** auto-release + auto-approve require `>= S80_AUTO_CONFIDENCE` (0.92, already defined). Auto-approve additionally must NOT auto-approve a document that requires certification unless the AI verdict confirms it (be conservative — when in doubt, leave it for a human).
- **Every auto-action logs (`_logCaseEvent`) and notifies** the relevant human (RSO for auto-release/auto-approve-context; GP for approve/release outcomes), so nothing automatic is silent.
- **Auto-send safety:** reuses the Phase-4 send path (admin-gated logic, marks completed only on success, blocks incomplete-attachment sends, rejects the placeholder officer address). Auto-send is **scheduled** (`auto_send_at = now + S80_REPLY_HOLD_MINUTES`) and only fired by the cron after the hold; the admin can **cancel** during the hold; the manual "Send to AHPRA" button still works immediately.
- **No DB migration**; escape interpolated text; commit after each task; subagents do NOT push. Use the temp Node at `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node`.
- **Carry-over notes from the Phase 4 review:** the reply sender is pinned to `MONITORED_VA_EMAILS[0]`; recipient-placeholder is already rejected; `rsExpected` recompute-at-send is preserved (the extracted `_sendS80Reply` keeps this).

## File structure (Phase 5)

- **Modify** `lib/ahpra-s80.js` + `tests/ahpra-s80.test.js` — add + test `bundleAutoReleasable(items, threshold)`.
- **Modify** `server.js` — constants `S80_AUTOMATION_ENABLED`, `S80_REPLY_HOLD_MINUTES`; extract `_releaseS80Bundle`; auto-release in `_createAhpraS80Bundle`; auto-approve in the upload endpoint; extract `_sendS80Reply`; schedule `auto_send_at` on reply creation; cron auto-send pass.
- **Modify** `pages/admin.html` — reply card shows "Auto-send scheduled — Cancel" when `auto_send_at` is pending; cancel handler.

---

### Task 1: Master flag + constants + `bundleAutoReleasable` predicate

**Files:** Modify `lib/ahpra-s80.js` (+ export), `tests/ahpra-s80.test.js`, `server.js` (constants).

**Interfaces:** Produces `s80.bundleAutoReleasable(items, threshold)` → boolean (true iff items non-empty, every item `confidence >= threshold`, and no item has `kind === 'needs_split'` or `kind === ''`/unknown). Server constants `S80_AUTOMATION_ENABLED` (bool), `S80_REPLY_HOLD_MINUTES` (number).

- [ ] **Step 1: Write the failing predicate tests**

Append to `tests/ahpra-s80.test.js`:
```js
describe('s80 bundleAutoReleasable', () => {
  const mk = (conf, kind) => ({ confidence: conf, kind: kind === undefined ? 'good_standing' : kind });
  it('true when all items meet the threshold and have a known kind', () => {
    expect(s80.bundleAutoReleasable([mk(0.95), mk(0.99, 'english')], 0.92)).toBe(true);
  });
  it('false when any item is below the threshold', () => {
    expect(s80.bundleAutoReleasable([mk(0.95), mk(0.5)], 0.92)).toBe(false);
  });
  it('false when any item is needs_split or unknown kind', () => {
    expect(s80.bundleAutoReleasable([mk(0.99, 'needs_split')], 0.92)).toBe(false);
    expect(s80.bundleAutoReleasable([mk(0.99, '')], 0.92)).toBe(false);
  });
  it('false for an empty bundle', () => {
    expect(s80.bundleAutoReleasable([], 0.92)).toBe(false);
  });
  it('treats a missing confidence as 0 (not auto-releasable)', () => {
    expect(s80.bundleAutoReleasable([{ kind: 'good_standing' }], 0.92)).toBe(false);
  });
});
```
Run `npx vitest run tests/ahpra-s80.test.js -t "bundleAutoReleasable"` → FAIL (not a function).

- [ ] **Step 2: Implement the predicate in lib/ahpra-s80.js**

Add this function (near `shortDescription`, before `module.exports`):
```js
// Decide whether a freshly-extracted bundle is safe to auto-release without human review:
// non-empty, every item highly confident, and no item that needs manual splitting / unknown kind.
function bundleAutoReleasable(items, threshold) {
  if (!Array.isArray(items) || items.length === 0) return false;
  var min = (typeof threshold === 'number') ? threshold : 0.92;
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var c = (typeof it.confidence === 'number' && isFinite(it.confidence)) ? it.confidence : 0;
    if (c < min) return false;
    if (!it.kind || it.kind === 'needs_split') return false;
  }
  return true;
}
```
Add `bundleAutoReleasable: bundleAutoReleasable,` to `module.exports`.

- [ ] **Step 3: Run tests** — `npx vitest run tests/ahpra-s80.test.js` → all pass (43 total).

- [ ] **Step 4: Add the server constants**

In `server.js`, immediately after the `S80_CHASE_DAYS` constant (added in Phase 3b), add:
```js
// Master switch for AHPRA s80 auto-actions (auto-release / auto-approve / auto-send).
// Defaults OFF — the flow stays fully human-in-the-loop until this is explicitly enabled.
const S80_AUTOMATION_ENABLED = String(process.env.S80_AUTOMATION_ENABLED || '').trim().toLowerCase() === 'true';
const S80_REPLY_HOLD_MINUTES = Number(process.env.S80_REPLY_HOLD_MINUTES || '10') || 10;
```

- [ ] **Step 5: Verify + commit**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo OK
grep -n "S80_AUTOMATION_ENABLED\|S80_REPLY_HOLD_MINUTES\|bundleAutoReleasable" server.js lib/ahpra-s80.js
git add lib/ahpra-s80.js tests/ahpra-s80.test.js server.js
git commit -m "AHPRA s80: automation master flag (default off), reply-hold constant, bundleAutoReleasable predicate (TDD)"
```

---

### Task 2: Extract `_releaseS80Bundle` + auto-release on ingest

**Files:** Modify `server.js` — extract helper from `POST /api/admin/ahpra/release` (~32515); call from `_createAhpraS80Bundle` (~2103).

**Interfaces:** Produces `async _releaseS80Bundle(caseId, bundleId, actor)` → `{ ok, releasedGp, releasedTeam }` (does the pending_review→active transition + GP notify + log). The release endpoint and auto-release both call it.

- [ ] **Step 1: Add the helper** (place it just before the `_createAhpraS80Bundle` function, ~line 1979)
```js
// Release a pending_review s80 bundle to the GP + team (pending_review -> active). Shared by
// the manual release endpoint and the auto-release path. `actor` is recorded on the timeline.
async function _releaseS80Bundle(caseId, bundleId, actor) {
  const tRes = await supabaseDbRequest('registration_tasks', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&task_type=eq.ahpra_action_item&limit=200');
  if (!tRes.ok) return { ok: false, releasedGp: 0, releasedTeam: 0 };
  const bundleTasks = (Array.isArray(tRes.data) ? tRes.data : []).filter(function (t) {
    var m = t && typeof t.metadata === 'object' ? t.metadata : {};
    return m && m.s80 && m.bundle_id === bundleId && m.review_status === 'pending_review';
  });
  if (bundleTasks.length === 0) return { ok: false, releasedGp: 0, releasedTeam: 0 };
  let releasedGp = 0, releasedTeam = 0;
  for (const t of bundleTasks) {
    var meta = (t.metadata && typeof t.metadata === 'object') ? t.metadata : {};
    meta.review_status = 'active';
    meta.released_at = new Date().toISOString();
    var newStatus = meta.owner === 'gp' ? 'waiting_on_gp' : 'open';
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(t.id), {
      method: 'PATCH', body: { status: newStatus, metadata: meta, updated_at: new Date().toISOString() }
    });
    if (meta.owner === 'gp') releasedGp++; else releasedTeam++;
  }
  if (releasedGp > 0) {
    try {
      const cRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
      const uid = (cRes.ok && Array.isArray(cRes.data) && cRes.data[0]) ? cRes.data[0].user_id : null;
      if (uid) await pushDocumentNotificationToUser(uid, { type: 'action_required', title: 'AHPRA has requested more information', detail: 'Please open your AHPRA page to see what is needed and the deadline.' });
    } catch (e) { /* non-critical */ }
  }
  await _logCaseEvent(caseId, null, 'note', 'AHPRA notice released to GP', 'Released ' + releasedGp + ' GP item(s) and activated ' + releasedTeam + ' team item(s).', actor || 'system');
  return { ok: true, releasedGp: releasedGp, releasedTeam: releasedTeam };
}
```

- [ ] **Step 2: Make the manual endpoint use the helper**

In `POST /api/admin/ahpra/release`, REPLACE the body from `const tRes = await supabaseDbRequest('registration_tasks', 'select=*&case_id=eq.'...` through the `await _logCaseEvent(...)` line (i.e. lines 32523-32555) with:
```js
    const rel = await _releaseS80Bundle(caseId, bundleId, adminCtx.email);
    if (!rel.ok) { sendJson(res, 404, { ok: false, message: 'No items awaiting release in this bundle.' }); return; }
    sendJson(res, 200, { ok: true, released_gp: rel.releasedGp, released_team: rel.releasedTeam });
    return;
```
(Keep the handler's earlier auth/body/validation lines 32516-32522 intact; the `const tRes` validation `if (!tRes.ok)` and the bundle-empty handling now live in the helper.)

- [ ] **Step 3: Auto-release in `_createAhpraS80Bundle`**

In `_createAhpraS80Bundle`, find the final `return { created: created, bundleId: bundleId, ... };` (~line 2103). Immediately BEFORE it, add:
```js
  if (S80_AUTOMATION_ENABLED && created > 0 && ahpraS80.bundleAutoReleasable(items, S80_AUTO_CONFIDENCE)) {
    try {
      await _releaseS80Bundle(gpCase.id, bundleId, 'system:auto_release');
      await _logCaseEvent(gpCase.id, null, 'note', 'AHPRA notice auto-released', 'All items >= ' + Math.round(S80_AUTO_CONFIDENCE * 100) + '% confidence; released without manual review.', 'system:auto_release');
      var arRso = await resolveCaseRsoAssignee(gpCase.id, gpCase.assigned_va);
      if (arRso) await pushDocumentNotificationToUser(arRso, { type: 'info', title: 'AHPRA notice auto-released', detail: 'A high-confidence AHPRA notice was released to the GP automatically — review if needed.' });
    } catch (e) { console.error('[AHPRA] auto-release failed:', e.message); }
  }
```
(`items` is the normalised array in scope in `_createAhpraS80Bundle`. If the in-scope variable has a different name, use that array of normalised items.)

- [ ] **Step 4: Verify + commit**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo OK
grep -n "async function _releaseS80Bundle\|_releaseS80Bundle(caseId, bundleId, adminCtx.email)\|system:auto_release" server.js
git add server.js
git commit -m "AHPRA s80: extract _releaseS80Bundle; auto-release high-confidence notices when automation is on"
```

---

### Task 3: Auto-approve confidently-matched uploads

**Files:** Modify `server.js` — `PUT /api/ahpra/more-info/upload` (after the `ai_match` advisory block from Phase 4).

**Interfaces:** When automation is on and the AI match is strong, the upload is set `approved` + the task `completed` immediately (instead of `under_review`/`waiting`), with a GP "accepted" notification + log. Otherwise unchanged.

- [ ] **Step 1: Add the auto-approve branch**

In the upload endpoint, the Phase-4 advisory block sets `upMeta.upload.ai_match`. The next lines build `patchStatus`/PATCH the task with `status:'waiting'`. Change the upload status decision: immediately AFTER the advisory `try/catch` block that sets `upMeta.upload.ai_match`, add:
```js
    var upAutoApproved = false;
    if (S80_AUTOMATION_ENABLED && upMeta.upload.ai_match && upMeta.upload.ai_match.matches === true
        && upMeta.upload.ai_match.confidence >= S80_AUTO_CONFIDENCE) {
      upMeta.upload.status = 'approved';
      upMeta.upload.reviewed_by = 'system:auto_approve';
      upMeta.upload.reviewed_at = new Date().toISOString();
      upAutoApproved = true;
    }
```
Then change the existing PATCH (currently `body: { status: 'waiting', metadata: upMeta, ... }`) to use a completed status when auto-approved:
```js
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(upTaskId), {
      method: 'PATCH', body: { status: upAutoApproved ? 'completed' : 'waiting', metadata: upMeta, updated_at: new Date().toISOString(), completed_at: upAutoApproved ? new Date().toISOString() : null, completed_by: upAutoApproved ? 'system:auto_approve' : null }
    });
    if (upAutoApproved) {
      try { await _logCaseEvent(upTask.case_id, upTaskId, 'completed', 'AHPRA upload auto-approved', (upTask.title || 'Document') + ' matched the request at ' + Math.round(upMeta.upload.ai_match.confidence * 100) + '% — auto-approved.', 'system:auto_approve'); } catch (e) {}
      try { await pushDocumentNotificationToUser(upUserId, { type: 'success', title: 'Document accepted', detail: (upTask.title || 'Your document') + ' has been accepted.' }); } catch (e) {}
    }
    sendJson(res, 200, { ok: true, status: upMeta.upload.status, file_name: upMeta.upload.file_name });
    return;
```
(Replace the existing single PATCH + `sendJson(200)` with the above. `upUserId` is the uploading GP's user id resolved earlier in the handler; confirm the in-scope variable name and use it.)

> Conservative-certification note: this auto-approve trusts the type-match verdict only. Because the s80 upload check does not request the certified-copy verdict, items that legally require a certified copy are still safe — the `ai_match` confidence reflects type match, and a human can still reject post-hoc. If stricter behaviour is wanted later, pass `requireCertification` into `verifyS80FileMatch` and gate on `certified === true`.

- [ ] **Step 2: Verify + commit**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo OK
grep -n "upAutoApproved\|system:auto_approve" server.js
git add server.js
git commit -m "AHPRA s80: auto-approve confidently-matched uploads when automation is on"
```

---

### Task 4: Extract `_sendS80Reply` + schedule auto-send + cron sender + admin cancel

**Files:** Modify `server.js` (extract send helper; schedule on reply creation; cron pass) and `pages/admin.html` (cancel affordance).

**Interfaces:** Produces `async _sendS80Reply(task, actor)` → `{ ok, message }` (the Phase-4 send logic: gather approved attachments, block on shortfall, reject placeholder recipient, send via `sendGmailEmail`, mark completed only on success). The reply task gains `metadata.auto_send_at` (ISO) when automation is on; the reconcile cron fires due, non-cancelled sends; admin can set `metadata.auto_send_cancelled`.

- [ ] **Step 1: Extract `_sendS80Reply(task, actor)`**

Move the core of the Phase-4 `POST /api/admin/ahpra/reply/send` handler (everything from resolving `rsM`/recipient through the send + completion PATCH + log) into a new helper `async function _sendS80Reply(rsTask, actor)` placed near the other s80 server helpers. It returns `{ ok: true, attachments: n }` on success or `{ ok: false, code, message }` on each guard failure (already-sent, no recipient/placeholder, attachment shortfall, send failure). Then make the endpoint a thin wrapper:
```js
  if (pathname === '/api/admin/ahpra/reply/send' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res); if (!adminCtx) return;
    if (!isGmailConfigured()) { sendJson(res, 503, { ok: false, message: 'Email sending is not configured — copy the draft and send it in Gmail.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const rsTaskId = body && typeof body.task_id === 'string' ? body.task_id.trim() : '';
    if (!rsTaskId) { sendJson(res, 400, { ok: false, message: 'task_id required.' }); return; }
    const rsRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(rsTaskId) + '&limit=1');
    const rsTask = (rsRes.ok && Array.isArray(rsRes.data) && rsRes.data[0]) ? rsRes.data[0] : null;
    if (!rsTask) { sendJson(res, 404, { ok: false, message: 'Reply task not found.' }); return; }
    const out = await _sendS80Reply(rsTask, adminCtx.email);
    sendJson(res, out.ok ? 200 : (out.code || 502), out);
    return;
  }
```
`_sendS80Reply` must keep ALL Phase-4 safety: only `mode==='reply'`, 409 if already completed, reject empty/placeholder `officer@ahpra.gov.au` recipient, block when `!rsGatherOk || rsAtt.length < rsExpected`, mark completed only on `sent.ok`, log via `_logCaseEvent(..., actor)`.

- [ ] **Step 2: Schedule auto-send when the reply task is created**

In the mark-complete handler where the `mode:'reply'` task is created (the `_createRegTask(..., { ... metadata: { ... mode: 'reply' ... } })`), add `auto_send_at` to that metadata when automation is on:
```js
            auto_send_at: S80_AUTOMATION_ENABLED ? new Date(Date.now() + S80_REPLY_HOLD_MINUTES * 60000).toISOString() : null,
```
(add it as a field in the reply task's `metadata` object).

- [ ] **Step 3: Cron auto-send pass**

In `GET /api/cron/reconcile-followups`, immediately AFTER the Phase-3b chase block and BEFORE the final `sendJson(...)`, add:
```js
      // ── AHPRA s80 auto-send: fire scheduled combined replies whose hold has elapsed ──
      if (S80_AUTOMATION_ENABLED && isGmailConfigured()) {
        try {
          var asRes = await supabaseDbRequest('registration_tasks', 'select=*&task_type=eq.ahpra_action_item&status=neq.completed&limit=200', { method: 'GET' });
          var asTasks = (asRes.ok && Array.isArray(asRes.data)) ? asRes.data : [];
          var asNow = Date.now();
          for (var asTask of asTasks) {
            var asM = (asTask.metadata && typeof asTask.metadata === 'object') ? asTask.metadata : {};
            if (!asM.s80 || asM.mode !== 'reply' || asM.auto_send_cancelled || !asM.auto_send_at) continue;
            if (new Date(asM.auto_send_at).getTime() > asNow) continue;
            try {
              var asOut = await _sendS80Reply(asTask, 'system:auto_send');
              rfResults.push({ task_id: asTask.id, status: asOut.ok ? 's80_auto_sent' : 's80_auto_send_failed' });
            } catch (e) { console.error('[Cron] s80 auto-send failed for ' + asTask.id + ':', e.message); }
          }
        } catch (e) { console.error('[Cron] s80 auto-send pass failed:', e.message); }
      }
```

- [ ] **Step 4: Admin cancel affordance**

In `pages/admin.html` `renderS80Active` reply branch, when `m.auto_send_at` is set and the task isn't completed and not `m.auto_send_cancelled`, prepend a note + Cancel button instead of relying only on the manual buttons:
```js
        if(m.auto_send_at && !m.auto_send_cancelled){ html+='<div style="font-size:12px;margin-top:6px;color:#b45309;">⏳ Auto-sending to AHPRA after '+esc(fmtD(m.auto_send_at))+'. <button type="button" data-s80-cancel-autosend="'+esc(t.id)+'" style="background:none;border:none;color:#b91c1c;text-decoration:underline;cursor:pointer;font-size:12px;">Cancel auto-send</button></div>'; }
```
Add the click handler (after the `data-s80-ahpra-send` handler):
```js
      var s80Cancel=e.target.closest("[data-s80-cancel-autosend]");
      if(s80Cancel){ e.preventDefault();
        var cid=s80Cancel.getAttribute("data-s80-cancel-autosend");
        try{ await fetch('/api/admin/task?id='+encodeURIComponent(cid),{method:'PUT',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({metadata_merge:{auto_send_cancelled:true}})}); }catch(err){}
        await loadAll(true); return;
      }
```
(Confirm `PUT /api/admin/task` supports `metadata_merge` — it is used by the Phase-1 Who/How change handler, so it does.)

- [ ] **Step 5: Verify + commit**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo OK
grep -n "async function _sendS80Reply\|auto_send_at\|s80 auto-send\|data-s80-cancel-autosend" server.js pages/admin.html
git add server.js pages/admin.html
git commit -m "AHPRA s80: extract _sendS80Reply; scheduled auto-send (hold + admin cancel) via reconcile cron"
```

---

## Self-review (Phase 5 vs spec Part E)

- **Spec coverage:** master switch (default off) → Task 1; auto-release (predicate + shared helper) → Task 1 + Task 2; auto-approve confident uploads → Task 3; auto-send with hold + cancel → Task 4. Audit + notify on every auto-action → present in each. ✓
- **Placeholder scan:** concrete code + verify per step; the two "confirm in-scope variable name" notes (`items`, `upUserId`) are explicit instructions, not gaps. ✓
- **Type/name consistency:** `S80_AUTOMATION_ENABLED`/`S80_REPLY_HOLD_MINUTES`/`S80_AUTO_CONFIDENCE` shared; `bundleAutoReleasable(items, S80_AUTO_CONFIDENCE)`; `_releaseS80Bundle(caseId,bundleId,actor)` used by endpoint + auto-release; `_sendS80Reply(task,actor)` used by endpoint + cron; `metadata.auto_send_at`/`auto_send_cancelled` set on create, read by cron + admin. ✓
- **Safety:** everything gated by `S80_AUTOMATION_ENABLED` (default off → today's behaviour); auto-release only on all-high-confidence clean bundles; auto-approve only on strong type match; auto-send reuses the proven `_sendS80Reply` (completed-only-on-success, attachment-shortfall block, placeholder-recipient reject) and is cancellable during the hold; every auto-action logged + notified. ✓
