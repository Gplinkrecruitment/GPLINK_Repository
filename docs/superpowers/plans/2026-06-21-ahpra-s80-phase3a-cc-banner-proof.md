# AHPRA s80 — Phase 3a: CC Banner + Proof-of-Request Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the institution-request loop from the doctor's side — (1) an **unmissable banner** telling the doctor they MUST CC the team / assigned RSO on any email to AHPRA (showing the exact address), and (2) let the doctor attach the institution's "sent to AHPRA" **confirmation as proof**, visible to the admin.

**Architecture:** Build on Phases 1–2 (merged to this branch). Server-side: a small helper to resolve the case's CC address, expose it on `GET /api/ahpra/more-info`, and a new proof-upload endpoint mirroring the existing upload endpoint (plus an admin signed-URL view). Client-side: a CC banner and a proof-upload control on the GP card; admin tray surfaces the proof. All data rides in `registration_tasks.metadata` (`metadata.proof`) — **no migration**.

**Tech Stack:** Node.js `server.js`, vanilla inline JS (`pages/ahpra.html`, `pages/admin.html`), Supabase storage. No UI test harness; pure helpers verified via extract-and-run with the temporary Node at `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node`; endpoints verified by `node --check` + review; UX verified manually.

**Spec:** `docs/superpowers/specs/2026-06-21-ahpra-s80-improvements-design.md` (Part C — the CC banner + proof items).

## Global Constraints

- **The CC banner must be unmissable** (top of the card, strong colour) and show the **exact** address to CC, plus a clear instruction to CC it on *any* email to AHPRA or to an institution.
- **CC address recipe:** assigned RSO's monitored Gmail; fall back to the team archive. Use `resolveCaseRsoAssignee(caseId, assigned_va)` → `va_gmail_accounts.email_address` (by that user_id) → `MASTER_ARCHIVE_EMAIL`.
- **Proof is optional** — it never blocks the existing "Mark as requested" flow; it is an extra reassurance attachment.
- **No DB migration** — proof lives in `metadata.proof` (same shape family as `metadata.upload`).
- **Ownership/precondition checks** on every new endpoint, mirroring the existing upload endpoint (session → case belongs to this GP; `metadata.s80 && owner==='gp' && mode==='request_institution' && review_status==='active'`).
- **Escape all interpolated text** (`s80Esc` on the GP page, `esc` in admin.html).
- **Commit after each task; subagents do NOT push** (controller pushes). No system Node — use the temp Node for `node --check` and helper extraction.

---

## File structure (Phase 3a)

- **Modify** `server.js` — add `resolveS80CcAddress(caseId, assignedVa)`; add `cc_address` to the `GET /api/ahpra/more-info` response; add `PUT /api/ahpra/more-info/proof` (GP proof upload) and `GET /api/admin/ahpra/item/proof-file` (admin signed-URL view).
- **Modify** `pages/ahpra.html` — add `renderS80CcBanner(cc)` + render it at the top of the card; add `s80ProofControl(item)` + a `handleAhpraProof` client handler + wire it; show proof state on request items.
- **Modify** `pages/admin.html` — surface `m.proof` in the `renderS80Active` request-institution branch (filename + View link).

---

### Task 1: CC-address helper + expose `cc_address` on the GP endpoint

**Files:**
- Modify: `server.js` — add helper near `resolveCaseRsoAssignee` (~line 341); extend `GET /api/ahpra/more-info` (response line ~29525)

**Interfaces:**
- Produces: `async resolveS80CcAddress(caseId, assignedVa)` → email string (RSO monitored Gmail, else `MASTER_ARCHIVE_EMAIL`). The `GET /api/ahpra/more-info` response gains `cc_address: string`. Task 2 consumes `data.cc_address`.

- [ ] **Step 1: Add the `resolveS80CcAddress` helper**

In `server.js`, immediately AFTER the `resolveCaseRsoAssignee` function (it ends with `return assignedVa || DEFAULT_RSO_USER_ID;\n}` around line 341), add:

```js
// The address a GP must CC on any email to AHPRA so we can see the thread: the
// assigned RSO's monitored Gmail, falling back to the team archive.
async function resolveS80CcAddress(caseId, assignedVa) {
  try {
    const rsoUserId = await resolveCaseRsoAssignee(caseId, assignedVa);
    if (rsoUserId) {
      const r = await supabaseDbRequest('va_gmail_accounts',
        'select=email_address&user_id=eq.' + encodeURIComponent(rsoUserId) + '&limit=1');
      const addr = (r.ok && Array.isArray(r.data) && r.data[0] && r.data[0].email_address)
        ? String(r.data[0].email_address).trim() : '';
      if (addr) return addr;
    }
  } catch (e) { /* fall through to archive */ }
  return MASTER_ARCHIVE_EMAIL;
}
```

- [ ] **Step 2: Compute + return `cc_address` from `GET /api/ahpra/more-info`**

In the `GET /api/ahpra/more-info` handler, find the success response line:
```js
    sendJson(res, 200, { ok: true, reference: s80Reference, deadline: s80Deadline, items: s80Items, team_items: s80TeamItems });
```
Immediately BEFORE it, add:
```js
    let s80CcAddress = '';
    if (s80Items.length) {
      try { s80CcAddress = await resolveS80CcAddress(s80CaseId); } catch (e) { s80CcAddress = ''; }
    }
```
Then change the response line to include it:
```js
    sendJson(res, 200, { ok: true, reference: s80Reference, deadline: s80Deadline, items: s80Items, team_items: s80TeamItems, cc_address: s80CcAddress });
```
(Leave the early `{ ok: true, items: [], deadline: null }` returns unchanged — a missing `cc_address` means the banner simply isn't shown.)

- [ ] **Step 3: Verify syntax + presence**

```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo "server.js OK"
grep -n "function resolveS80CcAddress\|cc_address: s80CcAddress\|s80CcAddress = await resolveS80CcAddress" server.js
```
Expected: `server.js OK`; the helper defined once, `s80CcAddress` computed once, `cc_address` in the response once. Read `git diff` to confirm only these additive edits.

- [ ] **Step 4: Commit (do NOT push)**

```bash
git add server.js
git commit -m "AHPRA s80: resolve + expose the GP's CC address (assigned RSO, archive fallback)"
```

---

### Task 2: Unmissable CC banner on the GP card

**Files:**
- Modify: `pages/ahpra.html` — add `renderS80CcBanner` near the other helpers; render it in `renderAhpraMoreInfoCard`

**Interfaces:**
- Consumes: `data.cc_address` (from Task 1).
- Produces: pure helper `renderS80CcBanner(cc)` → banner HTML (or `''` when no address).

- [ ] **Step 1: Add the banner helper**

In `pages/ahpra.html`, immediately AFTER the `s80StatusChip` function (added in Phase 2), add:

```js
    // Unmissable reminder: the GP must CC the team on any email to AHPRA / an institution.
    function renderS80CcBanner(cc) {
      if (!cc) return '';
      var ccSafe = s80Esc(cc);
      return '<div style="margin:14px auto 0;max-width:520px;border:1px solid var(--gp-amber-ink,#b45309);background:rgba(245,158,11,0.12);border-radius:12px;padding:12px 14px;">'
        + '<div style="font-size:13px;font-weight:800;color:var(--gp-amber-ink,#b45309);">⚠️ Important — always CC us</div>'
        + '<div style="font-size:13px;color:var(--ink);line-height:1.5;margin-top:4px;">When you email AHPRA — or ask an institution (e.g. GMC, OET) to send a document to AHPRA — you <strong>must add this address to CC</strong> so we can track it for you:</div>'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;">'
        + '<code style="font-size:13px;font-weight:700;background:var(--surface,#f8fafc);border:1px solid var(--border);border-radius:6px;padding:4px 8px;">' + ccSafe + '</code>'
        + '<button type="button" data-mi-copy-cc="' + ccSafe + '" class="btn-secondary" style="font-size:12px;padding:4px 10px;">Copy</button>'
        + '</div></div>';
    }
```

- [ ] **Step 2: Verify the helper (extract-and-run)**

Create `$CLAUDE_JOB_DIR/tmp/verify-ccbanner.cjs`:
```js
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const start = html.indexOf('function renderS80CcBanner(');
let i = html.indexOf('{', start), depth=0, end=-1;
for(; i<html.length; i++){ if(html[i]==='{')depth++; else if(html[i]==='}'){depth--; if(depth===0){end=i+1;break;}} }
const s80Esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const factory = new Function('s80Esc', html.slice(start,end) + '\nreturn renderS80CcBanner;');
const banner = factory(s80Esc);
let pass=0, fail=0; const ok=(n,c)=>{ c?pass++:(fail++,console.log('FAIL',n)); };
ok('shows the address', banner('hazel@mygplink.com.au').includes('hazel@mygplink.com.au'));
ok('has CC instruction', banner('x@y.com').toLowerCase().includes('cc'));
ok('empty -> no banner', banner('') === '');
ok('escapes address', banner('a<b>@y.com').includes('a&lt;b&gt;@y.com'));
console.log('RESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail?1:0);
```
Run: `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node "$CLAUDE_JOB_DIR/tmp/verify-ccbanner.cjs" "$(pwd)/pages/ahpra.html"`
Expected: PASS 4/4.

- [ ] **Step 3: Render the banner near the top of the card**

In `renderAhpraMoreInfoCard`, find the intro paragraph line ending the heading block (the `<p ...>Please complete the items below ... + ref + '.</p>'` line) — it is immediately followed by `deadlineHtml +`. Insert the banner between them so it sits high on the card. Change:
```js
        deadlineHtml +
        progressHtml +
```
to:
```js
        renderS80CcBanner(data.cc_address) +
        deadlineHtml +
        progressHtml +
```

- [ ] **Step 4: Wire the "Copy" button** (event delegation, consistent with existing handlers)

In `wireAhpraMoreInfo` (the function that attaches `[data-mi-mark]` / `[data-mi-upload]` listeners), add a block to wire the copy button:
```js
      grid.querySelectorAll('[data-mi-copy-cc]').forEach(function (b) {
        b.addEventListener('click', function () {
          var addr = b.getAttribute('data-mi-copy-cc') || '';
          if (navigator.clipboard) { navigator.clipboard.writeText(addr).then(function(){ showToast('Address copied'); }, function(){ showToast('Copy failed — select it manually.'); }); }
          else { showToast('Copy not supported — select it manually.'); }
        });
      });
```

- [ ] **Step 5: Re-run helper verify (green) + read the diff**

Run Step 2 command again → PASS 4/4. Read `git diff`: banner helper added once; rendered once (after the intro `<p>`, before `deadlineHtml`); copy button wired once; concatenation balanced; `cc` escaped via `s80Esc`.

- [ ] **Step 6: Commit (do NOT push)**

```bash
git add pages/ahpra.html
git commit -m "AHPRA s80 (GP): unmissable 'CC us on AHPRA emails' banner with the exact address"
```

---

### Task 3: Proof-upload endpoint (GP) + admin proof-view endpoint

**Files:**
- Modify: `server.js` — add `PUT /api/ahpra/more-info/proof` (near the existing `PUT /api/ahpra/more-info/upload`, ~line 29685) and `GET /api/admin/ahpra/item/proof-file` (near the existing `GET /api/admin/ahpra/item/file`)

**Interfaces:**
- Produces: `PUT /api/ahpra/more-info/proof` stores `metadata.proof = { file_name, storage_path, storage_bucket, mime_type, file_size, uploaded_at, country }` on a GP request-institution item; returns `{ ok, file_name }`. `GET /api/admin/ahpra/item/proof-file?task_id=...` 302-redirects to a signed URL. Task 4 (GP UI) calls the PUT; Task 5 (admin) links the GET.

- [ ] **Step 1: Add the GP proof-upload endpoint**

In `server.js`, immediately AFTER the closing of the `PUT /api/ahpra/more-info/upload` handler (the `return; }` that ends that `if` block), add a new handler that mirrors it but writes `metadata.proof` and accepts request-institution items:

```js
  // ── AHPRA s80: GP uploads proof that an institution-request was sent to AHPRA ──
  if (pathname === '/api/ahpra/more-info/proof' && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res); if (!session) return;
    const pfEmail = getSessionEmail(session);
    const pfUserId = getSessionSupabaseUserId(session) || (pfEmail ? await getSupabaseUserIdByEmail(pfEmail) : null);
    if (!pfUserId) { sendJson(res, 401, { ok: false }); return; }
    let pfBody; try { pfBody = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const pfTaskId = pfBody && typeof pfBody.task_id === 'string' ? pfBody.task_id.trim() : '';
    const pfFileName = pfBody && typeof pfBody.fileName === 'string' ? pfBody.fileName : '';
    const pfMime = pfBody && typeof pfBody.mimeType === 'string' ? pfBody.mimeType : '';
    const pfDataUrl = pfBody && typeof pfBody.fileDataUrl === 'string' ? pfBody.fileDataUrl : '';
    if (!pfTaskId || !pfDataUrl) { sendJson(res, 400, { ok: false, message: 'task_id and file required.' }); return; }
    const pfRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(pfTaskId) + '&limit=1');
    const pfTask = (pfRes.ok && Array.isArray(pfRes.data) && pfRes.data[0]) ? pfRes.data[0] : null;
    if (!pfTask) { sendJson(res, 404, { ok: false, message: 'Item not found.' }); return; }
    const pfMeta = (pfTask.metadata && typeof pfTask.metadata === 'object') ? pfTask.metadata : {};
    const pfCaseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(pfTask.case_id) + '&limit=1');
    const pfCaseUser = (pfCaseRes.ok && Array.isArray(pfCaseRes.data) && pfCaseRes.data[0]) ? pfCaseRes.data[0].user_id : null;
    if (pfCaseUser !== pfUserId) { sendJson(res, 403, { ok: false }); return; }
    if (!pfMeta.s80 || pfMeta.owner !== 'gp' || pfMeta.mode !== 'request_institution' || pfMeta.review_status !== 'active') {
      sendJson(res, 400, { ok: false, message: 'This item does not accept a confirmation upload.' }); return;
    }
    const pfBuffer = Buffer.from(String(pfDataUrl).replace(/^data:[^;]+;base64,/, ''), 'base64');
    const pfCheck = validateFileUpload(pfBuffer, pfMime, pfFileName);
    if (!pfCheck.valid) { sendJson(res, 400, { ok: false, message: pfCheck.errors[0] || 'File validation failed.' }); return; }
    const pfCountry = normalizeDocumentCountry(pfBody.country) || 'uk';
    const pfDocKey = ('ahpra_s80proof_' + pfTaskId).replace(/[^a-z0-9_-]/gi, '');
    const pfPath = buildPreparedDocumentStoragePath(pfUserId, pfCountry, pfDocKey);
    const pfUploaded = await supabaseStorageUploadObject(SUPABASE_DOCUMENT_BUCKET, pfPath, pfDataUrl, pfMime);
    if (!pfUploaded) { sendJson(res, 502, { ok: false, message: 'Could not store the file.' }); return; }
    pfMeta.proof = {
      file_name: pfCheck.sanitisedFileName || pfFileName || 'confirmation',
      storage_path: pfPath,
      storage_bucket: SUPABASE_DOCUMENT_BUCKET,
      mime_type: pfMime,
      file_size: pfBuffer.length,
      uploaded_at: new Date().toISOString(),
      country: pfCountry
    };
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(pfTaskId), {
      method: 'PATCH', body: { metadata: pfMeta, updated_at: new Date().toISOString() }
    });
    sendJson(res, 200, { ok: true, file_name: pfMeta.proof.file_name });
    return;
  }
```

- [ ] **Step 2: Add the admin proof-view endpoint**

In `server.js`, immediately AFTER the closing of the `GET /api/admin/ahpra/item/file` handler (the existing signed-URL view for uploads), add a parallel handler for proof:

```js
  // ── AHPRA s80: signed URL for the team to view a GP-uploaded proof file ──
  if (pathname === '/api/admin/ahpra/item/proof-file' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const taskId = url.searchParams.get('task_id');
    if (!taskId) { sendJson(res, 400, { ok: false, message: 'Missing task_id.' }); return; }
    const tRes = await supabaseDbRequest('registration_tasks', 'select=metadata&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    const task = (tRes.ok && Array.isArray(tRes.data) && tRes.data[0]) ? tRes.data[0] : null;
    const pf = task && task.metadata && task.metadata.proof ? task.metadata.proof : null;
    if (!pf || !pf.storage_path) { sendJson(res, 404, { ok: false, message: 'No proof file.' }); return; }
    const signed = await supabaseStorageCreateSignedUrl(pf.storage_bucket || SUPABASE_DOCUMENT_BUCKET, pf.storage_path, pf.file_name || '');
    if (!signed) { sendJson(res, 502, { ok: false, message: 'Could not create link.' }); return; }
    res.writeHead(302, { Location: signed });
    res.end();
    return;
  }
```

- [ ] **Step 3: Verify**

```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo "server.js OK"
grep -n "more-info/proof\|item/proof-file\|pfMeta.proof = {" server.js
```
Expected: `server.js OK`; both new routes present; `pfMeta.proof` written once. Read `git diff` and confirm the two handlers mirror their siblings (ownership checks present; proof PUT does NOT change task status; admin GET is admin-gated).

- [ ] **Step 4: Commit (do NOT push)**

```bash
git add server.js
git commit -m "AHPRA s80: proof-of-request upload endpoint (GP) + admin proof-view endpoint"
```

---

### Task 4: Proof-upload control on the GP request items

**Files:**
- Modify: `pages/ahpra.html` — add `s80ProofControl(item)` helper; use it in the `request_institution` branch of `ahpraMoreInfoItemHtml`; add `handleAhpraProof` + wire the file input

**Interfaces:**
- Consumes: `item.proof_file_name` (added to the GP item shape — see Step 1 note) and `item.id`.
- Produces: pure helper `s80ProofControl(item)`; client handler `handleAhpraProof(taskId, file)`.

> **Note (data shape):** the GP endpoint must expose whether a proof exists. In `GET /api/ahpra/more-info`, the per-item object is built around line 29511. Add `proof_file_name: (m.proof && m.proof.file_name) || ''` to that object. (This is a one-line addition in the same handler Task 1 touched; include it here in Task 4 Step 0 so the control can render state.)

- [ ] **Step 0: Expose proof state on the GP item**

In `server.js`, in the `GET /api/ahpra/more-info` per-item push (the object that already has `gp_marked_complete_at`, `due_date`, etc.), add the line:
```js
        proof_file_name: (m.proof && m.proof.file_name) || '',
```
Verify: `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo OK` and `grep -n "proof_file_name:" server.js`.

- [ ] **Step 1: Add the proof-control helper**

In `pages/ahpra.html`, immediately AFTER `renderS80CcBanner` (Task 2), add:
```js
    // Optional "attach the institution's confirmation" control for request items.
    function s80ProofControl(item) {
      if (item.proof_file_name) {
        return '<div style="margin-top:8px;font-size:12px;color:var(--gp-green-ink,#15803d);">📎 Confirmation attached: ' + s80Esc(item.proof_file_name) + '</div>';
      }
      return '<label style="margin-top:8px;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-muted);cursor:pointer;text-decoration:underline;">Attach the institution’s confirmation (optional)'
        + '<input type="file" accept="image/*,.pdf,application/pdf" data-mi-proof="' + s80Esc(item.id) + '" style="display:none;"></label>';
    }
```

- [ ] **Step 2: Verify the helper (extract-and-run)**

Create `$CLAUDE_JOB_DIR/tmp/verify-proofctrl.cjs`:
```js
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const start = html.indexOf('function s80ProofControl(');
let i = html.indexOf('{', start), depth=0, end=-1;
for(; i<html.length; i++){ if(html[i]==='{')depth++; else if(html[i]==='}'){depth--; if(depth===0){end=i+1;break;}} }
const s80Esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const factory = new Function('s80Esc', html.slice(start,end) + '\nreturn s80ProofControl;');
const ctrl = factory(s80Esc);
let pass=0, fail=0; const ok=(n,c)=>{ c?pass++:(fail++,console.log('FAIL',n)); };
ok('no proof -> file input', ctrl({id:'t1', proof_file_name:''}).includes('data-mi-proof="t1"'));
ok('has proof -> filename shown', ctrl({id:'t1', proof_file_name:'gmc.pdf'}).includes('gmc.pdf') && !ctrl({id:'t1', proof_file_name:'gmc.pdf'}).includes('data-mi-proof'));
ok('escapes filename', ctrl({id:'t1', proof_file_name:'<x>.pdf'}).includes('&lt;x&gt;.pdf'));
console.log('RESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail?1:0);
```
Run it with the temp Node + the ahpra.html path → expect PASS 3/3.

- [ ] **Step 3: Show the control in the request-institution branch**

In `ahpraMoreInfoItemHtml`, in the `if (item.mode === 'request_institution') {` block, append the proof control to BOTH the `requested` and `todo` `action` strings. After the existing `if (item.status === 'requested') { action = '...Undo...</div>'; } else { ... action = hint + '<button ...>Mark as requested</button>'; }` block, add ONE line right after that whole `if/else` closes (still inside the `request_institution` branch):
```js
        action += s80ProofControl(item);
```

- [ ] **Step 4: Add the `handleAhpraProof` client handler + wire the input**

Immediately AFTER the existing `handleAhpraUpload` function, add a near-identical handler that hits the proof endpoint:
```js
    async function handleAhpraProof(taskId, file) {
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) { showToast('File is too large. Maximum size is 25 MB.'); return; }
      showToast('Uploading…');
      var reader = new FileReader();
      reader.onerror = reader.onabort = function () { showToast('Could not read the file. Please try again.'); };
      reader.onload = async function () {
        try {
          var r = await fetch('/api/ahpra/more-info/proof', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            body: JSON.stringify({ task_id: taskId, fileName: file.name, mimeType: file.type, fileDataUrl: reader.result, country: getPageCountry() })
          });
          var d = await r.json().catch(function () { return {}; });
          if (!d.ok) { showToast(d.message || 'Upload failed. Please try again.'); return; }
          showToast('Confirmation attached — thank you.');
          loadAhpraMoreInfo();
        } catch (e) { showToast('Upload failed. Please try again.'); }
      };
      reader.readAsDataURL(file);
    }
```
Then in `wireAhpraMoreInfo`, add (next to the `[data-mi-upload]` wiring):
```js
      grid.querySelectorAll('[data-mi-proof]').forEach(function (inp) {
        inp.addEventListener('change', function (e) {
          var f = e.target.files && e.target.files[0];
          if (f) handleAhpraProof(inp.getAttribute('data-mi-proof'), f);
        });
      });
```

- [ ] **Step 5: Re-run both helper verifies (green) + read the diff**

Run `verify-proofctrl.cjs` (3/3) and `verify-ccbanner.cjs` (4/4, regression). Read `git diff`: `s80ProofControl` added once + appended in the request branch once; `handleAhpraProof` added once + wired once; `proof_file_name` on the server item (Step 0); concatenation balanced; all escaped.

- [ ] **Step 6: Commit (do NOT push)**

```bash
git add server.js pages/ahpra.html
git commit -m "AHPRA s80 (GP): optional proof-of-request upload on institution items"
```

---

### Task 5: Surface the proof to the admin (in-progress tray)

**Files:**
- Modify: `pages/admin.html` — `renderS80Active` request-institution branch (the `else if(m.mode==='request_institution')` block)

**Interfaces:**
- Consumes: `m.proof` (set by Task 3) via `s80Meta(t)`.
- Produces: a "GP attached confirmation" line + View link in the admin in-progress view.

- [ ] **Step 1: Show the proof line in the admin request branch**

In `pages/admin.html`, find the `renderS80Active` request-institution branch (the block `} else if(m.mode==='request_institution'){ ... }`). Inside it, after the existing waiting/marked-complete line, add a proof line. Locate the closing of that branch's content (after the `m.gp_marked_complete_at` if/else) and insert:
```js
        if(m.proof&&m.proof.file_name){ html+='<div style="font-size:12px;margin-top:6px;color:#15803d;">📎 GP attached confirmation: '+esc(m.proof.file_name)+' <a href="/api/admin/ahpra/item/proof-file?task_id='+esc(t.id)+'" target="_blank" rel="noopener" style="color:#2563eb;">View</a></div>'; }
```

- [ ] **Step 2: Dashboard parity check**

```bash
grep -n "renderS80Active\|m.mode==='request_institution'" pages/ceo-dashboard.html
```
- If `renderS80Active` exists in `ceo-dashboard.html`, mirror Step 1 there. (Phase 2 confirmed `renderS80Active` is NOT in ceo-dashboard.html — expect no match; if so, no change, note it.)

- [ ] **Step 3: Verify (extract-and-run the branch is hard; use diff read + targeted check)**

```bash
grep -n "item/proof-file?task_id=" pages/admin.html
```
Expected: the View link appears once. Read `git diff` to confirm the proof line is inside the `request_institution` branch and `esc()` wraps the filename + task id.

- [ ] **Step 4: Manual verification (no UI harness — report as manual)**

Manually (report as manual): with a GP request-institution item, upload a proof file from the GP page, then open the admin in-progress tray for that case and confirm "📎 GP attached confirmation: <name> · View" appears and the View link opens the file.

- [ ] **Step 5: Commit (do NOT push)**

```bash
git add pages/admin.html
git commit -m "AHPRA s80 (admin): surface GP-attached institution confirmation in the in-progress tray"
```

---

## Self-review (Phase 3a vs spec Part C)

- **Spec coverage:** unmissable CC banner with exact address → Task 1 (resolve+expose) + Task 2 (banner). Proof-of-request upload → Task 3 (endpoints) + Task 4 (GP UI) + Task 5 (admin surface). AI thread-watch / auto-chase / "confirmed received" status → deferred to **Phase 3b** (documented). ✓
- **Placeholder scan:** every step has concrete code + a verify command. ✓
- **Type consistency:** `resolveS80CcAddress` → `cc_address` (response) → `data.cc_address` → `renderS80CcBanner(cc)`. `metadata.proof.{file_name,storage_path,...}` written by Task 3, read by Task 3 admin endpoint + exposed as `proof_file_name` (Task 4 Step 0) consumed by `s80ProofControl`, and read as `m.proof` by Task 5. Endpoint paths consistent: `PUT /api/ahpra/more-info/proof`, `GET /api/admin/ahpra/item/proof-file`. ✓
- **Safety:** proof endpoint mirrors the proven upload endpoint's ownership/precondition checks; proof never changes task status (purely additive); admin view is admin-gated; banner/control no-op when no address/no proof; all text escaped. ✓
