# AHPRA s80 — Phase 4: AI Upload Pre-check + Send Reply From App — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Save admin time — (1) when a doctor uploads a file, AI checks whether it matches the requested item and shows the verdict in the admin review, and (2) the combined AHPRA reply can be sent from the app on the original email thread with the approved files attached, in one click.

**Architecture:** Reuse existing infrastructure: `buildQualContentBlock` + `extractAiJsonObject` + `ANTHROPIC_SCAN_MODEL` (already temperature-free) for the upload match check; `sendGmailEmail(...)` (full MIME + attachments + threadId/In-Reply-To) for the reply; `supabaseStorageDownloadObject` to load approved files. All data in `registration_tasks.metadata` — no migration. The reply send is a **human-pressed one-click action** in Phase 4 (auto-send with a hold window is Phase 5).

**Tech Stack:** Node.js `server.js`, vanilla inline JS (`pages/admin.html`), Anthropic API, Gmail API (service account, `gmail.send` scope already present), Supabase storage.

**Spec:** `docs/superpowers/specs/2026-06-21-ahpra-s80-improvements-design.md` (Part B).

## Global Constraints

- **AI match check is ADVISORY — it must NEVER block the GP's upload.** Compute best-effort, store the verdict, always save the upload. Budget-gate the AI call with `checkAnthropicBudget()`.
- **AI calls use `ANTHROPIC_SCAN_MODEL` (claude-opus-4-8) with NO `temperature`** (the existing scan helpers already omit it).
- **Never mark the reply "sent" unless the Gmail send actually succeeded** (CLAUDE.md rule). On failure or Gmail-not-configured, leave the task open and surface the error; the existing Copy-draft / Mark-sent fallback stays.
- **The reply send is admin-gated** (`requireAdminSession`) and human-triggered in Phase 4.
- **No DB migration**; escape interpolated text; commit after each task; subagents do NOT push. Use the temp Node at `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node` for `node --check` + helper extraction.

## File structure (Phase 4)

- **Modify** `server.js` — add `verifyS80FileMatch(...)`; store `metadata.upload.ai_match` in the upload endpoint; add `POST /api/admin/ahpra/reply/send`.
- **Modify** `pages/admin.html` — show the AI match verdict in the upload-review branch; add a "Send to AHPRA" button + handler in the reply branch.

---

### Task 1: AI upload pre-check (advisory) — server.js

**Files:** Modify `server.js` — add helper near `verifyQualificationDocument` (~line 5139); inject into `PUT /api/ahpra/more-info/upload` (the `upMeta.upload = {...}` block ~29791).

**Interfaces:** Produces `async verifyS80FileMatch(fileBuffer, mimeType, itemTitle, itemDetail)` → `{ ok, matches, confidence, reason }`. The upload item's `metadata.upload.ai_match = { matches, confidence, reason }` (or absent if the check couldn't run). Task 2 (admin) + Phase 5 (auto-approve) consume it.

- [ ] **Step 1: Add the `verifyS80FileMatch` helper**

In `server.js`, immediately AFTER the `verifyQualificationDocument` function (it ends a few lines below `async function verifyQualificationDocument(`, around line 5290), add:

```js
// Lightweight AI check: does an uploaded file match the AHPRA s80 item that was requested?
// Reuses the qualification-scan building blocks; uses the scan model (no temperature).
async function verifyS80FileMatch(fileBuffer, mimeType, itemTitle, itemDetail) {
  if (!ANTHROPIC_API_KEY || !(await checkAnthropicBudget())) return { ok: false, reason: 'AI unavailable' };
  try {
    var block = buildQualContentBlock(fileBuffer, mimeType);
    var sys = 'You check whether an uploaded file is the document an AHPRA registration item asked for. '
      + 'Return JSON only: {"matches": true|false, "confidence": 0.0-1.0, "reason": "one short sentence"}. '
      + 'Judge the document TYPE against the request (e.g. a reference letter vs a CV); be lenient on formatting.';
    var usr = 'Requested item: "' + String(itemTitle || '') + '"\nDetails: ' + String(itemDetail || '').slice(0, 1500)
      + '\n\nDoes the attached file appear to be the correct document for this request?';
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 30000);
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ANTHROPIC_SCAN_MODEL, max_tokens: 256,
        system: sys,
        messages: [{ role: 'user', content: [block, { type: 'text', text: usr }] }]
      })
    });
    clearTimeout(t);
    var data = await res.json();
    if (data && data.usage) recordAnthropicSpend(data.usage.input_tokens || 0, data.usage.output_tokens || 0, data.usage.cache_read_input_tokens || 0, data.usage.cache_creation_input_tokens || 0);
    var txt = data && data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';
    var v = extractAiJsonObject(txt);
    if (!v) return { ok: false, reason: 'AI returned no verdict' };
    return { ok: true, matches: v.matches === true, confidence: Number(v.confidence) || 0, reason: String(v.reason || '').slice(0, 300) };
  } catch (e) {
    console.error('[S80 match] failed:', e.message);
    return { ok: false, reason: 'AI error' };
  }
}
```

- [ ] **Step 2: Store the advisory verdict in the upload endpoint**

In `PUT /api/ahpra/more-info/upload`, find the `upMeta.upload = { ... };` block (ends with `country: upCountry\n    };`). Immediately AFTER that closing `};` and BEFORE the `await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(upTaskId), {` PATCH, add:

```js
    try {
      var upMatch = await verifyS80FileMatch(upBuffer, upMime, upTask.title, (upMeta.detail || upTask.title));
      if (upMatch && upMatch.ok) upMeta.upload.ai_match = { matches: upMatch.matches, confidence: upMatch.confidence, reason: upMatch.reason };
    } catch (e) { /* advisory only — never block the upload */ }
```

- [ ] **Step 3: Verify**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo "server.js OK"
grep -n "function verifyS80FileMatch\|upMeta.upload.ai_match = {" server.js
# Confirm the new AI call has no temperature:
awk '/async function verifyS80FileMatch/,/^}/' server.js | grep -i temperature && echo "!!! temperature present" || echo "OK: no temperature"
```
Expect `server.js OK`; helper once; ai_match write once; "OK: no temperature".

- [ ] **Step 4: Commit (do NOT push)**
```bash
git add server.js
git commit -m "AHPRA s80: advisory AI match check on GP uploads (scan model, no temperature, never blocks)"
```

---

### Task 2: Show the AI match verdict in the admin upload review — admin.html

**Files:** Modify `pages/admin.html` — `renderS80Active` upload branch (~line 2825-2831).

**Interfaces:** Consumes `m.upload.ai_match` via `s80Meta`. Produces pure helper `renderS80UploadAiMatch(up)`.

- [ ] **Step 1: Add the helper**

In `pages/admin.html`, immediately AFTER the `renderS80GpPreview` function (or near the other s80 render helpers, e.g. right after `renderS80Confidence`), add:
```js
  function renderS80UploadAiMatch(up){
    if(!up || !up.ai_match) return '';
    var am=up.ai_match, pct=(typeof am.confidence==='number')?Math.round(am.confidence*100):null;
    var good=am.matches===true && (pct===null || pct>=70);
    var col=good?'#15803d':'#b91c1c', bg=good?'#dcfce7':'#fee2e2';
    var label=(am.matches===true?'AI: likely a match':'AI: possible mismatch')+(pct!==null?' ('+pct+'%)':'');
    return '<div style="margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
      +'<span style="font-size:10px;font-weight:700;color:'+col+';background:'+bg+';border-radius:5px;padding:2px 7px;">'+esc(label)+'</span>'
      +(am.reason?'<span style="font-size:11px;color:var(--muted);">'+esc(am.reason)+'</span>':'')+'</div>';
  }
```

- [ ] **Step 2: Render it in the upload-review branch**

In `renderS80Active`, in the `else if(m.mode==='upload'){` branch, find the under-review line:
```js
          html+='<div style="font-size:12px;margin-top:6px;color:#b45309;">⏳ GP uploaded: '+esc(up.file_name||'file')+'</div>';
```
Immediately AFTER it, add:
```js
          html+=renderS80UploadAiMatch(up);
```

- [ ] **Step 3: Verify (extract-and-run)**

Create `$CLAUDE_JOB_DIR/tmp/verify-aimatch.cjs`:
```js
const fs=require('fs');const html=fs.readFileSync(process.argv[2],'utf8');
const start=html.indexOf('function renderS80UploadAiMatch(');let i=html.indexOf('{',start),d=0,end=-1;
for(;i<html.length;i++){if(html[i]==='{')d++;else if(html[i]==='}'){d--;if(d===0){end=i+1;break;}}}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const r=new Function('esc',html.slice(start,end)+'\nreturn renderS80UploadAiMatch;')(esc);
let p=0,f=0;const ok=(n,c)=>{c?p++:(f++,console.log('FAIL',n));};
ok('match -> green likely', r({ai_match:{matches:true,confidence:0.95,reason:'x'}}).includes('likely a match') && r({ai_match:{matches:true,confidence:0.95}}).includes('#15803d'));
ok('mismatch -> red', r({ai_match:{matches:false,confidence:0.3,reason:'looks like a CV'}}).includes('possible mismatch') && r({ai_match:{matches:false,confidence:0.3}}).includes('#b91c1c'));
ok('no ai_match -> empty', r({})==='' && r(null)==='');
ok('escapes reason', r({ai_match:{matches:false,confidence:0.2,reason:'<x>'}}).includes('&lt;x&gt;'));
console.log('RESULT:',p,'passed,',f,'failed');process.exit(f?1:0);
```
Run with temp Node + admin.html path → expect 4/4.

- [ ] **Step 4: Commit (do NOT push)**
```bash
git add pages/admin.html
git commit -m "AHPRA s80 (admin): show AI 'does this match?' verdict on GP uploads"
```

---

### Task 3: Send-reply-from-app endpoint — server.js

**Files:** Modify `server.js` — add `POST /api/admin/ahpra/reply/send` near the other admin AHPRA endpoints (after `/api/admin/ahpra/item/review` / `/api/admin/ahpra/item/proof-file`).

**Interfaces:** `POST /api/admin/ahpra/reply/send` body `{ task_id }`. Loads the reply task (`metadata.mode==='reply'`), gathers the bundle's approved upload files as attachments, sends the draft on the original thread via `sendGmailEmail`, then marks the task completed. Returns `{ ok }` or `{ ok:false, message }`.

- [ ] **Step 1: Add the endpoint**

In `server.js`, immediately AFTER the closing `return; }` of the `GET /api/admin/ahpra/item/proof-file` handler (added in Phase 3a), add:

```js
  // ── AHPRA s80: send the combined reply to AHPRA from the app (one-click) ──
  if (pathname === '/api/admin/ahpra/reply/send' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    if (!isGmailConfigured()) { sendJson(res, 503, { ok: false, message: 'Email sending is not configured — copy the draft and send it in Gmail.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const rsTaskId = body && typeof body.task_id === 'string' ? body.task_id.trim() : '';
    if (!rsTaskId) { sendJson(res, 400, { ok: false, message: 'task_id required.' }); return; }
    const rsRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(rsTaskId) + '&limit=1');
    const rsTask = (rsRes.ok && Array.isArray(rsRes.data) && rsRes.data[0]) ? rsRes.data[0] : null;
    if (!rsTask) { sendJson(res, 404, { ok: false, message: 'Reply task not found.' }); return; }
    const rsM = (rsTask.metadata && typeof rsTask.metadata === 'object') ? rsTask.metadata : {};
    if (!rsM.s80 || rsM.mode !== 'reply') { sendJson(res, 400, { ok: false, message: 'Not an AHPRA reply task.' }); return; }
    if (rsTask.status === 'completed') { sendJson(res, 409, { ok: false, message: 'This reply was already sent.' }); return; }
    const rsDraft = (rsM.draft && typeof rsM.draft === 'object') ? rsM.draft : {};
    const rsTo = (rsM.original_email && rsM.original_email.sender) || (rsM.officer && rsM.officer.email) || '';
    if (!rsTo) { sendJson(res, 400, { ok: false, message: 'No AHPRA officer address on file — send manually.' }); return; }
    const rsThreadId = rsTask.gmail_thread_id || (rsM.original_email && rsM.original_email.threadId) || '';
    // Gather the bundle's approved upload files as attachments.
    const rsAtt = [];
    try {
      const rsBundle = await supabaseDbRequest('registration_tasks', 'select=metadata&case_id=eq.' + encodeURIComponent(rsTask.case_id) + '&task_type=eq.ahpra_action_item&limit=200');
      const rsRows = (rsBundle.ok && Array.isArray(rsBundle.data)) ? rsBundle.data : [];
      for (const row of rsRows) {
        const rm = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
        if (rm.s80 && rm.bundle_id === rsM.bundle_id && rm.owner === 'gp' && rm.mode === 'upload' && rm.upload && rm.upload.status === 'approved' && rm.upload.storage_path) {
          const dl = await supabaseStorageDownloadObject(rm.upload.storage_bucket || SUPABASE_DOCUMENT_BUCKET, rm.upload.storage_path);
          if (dl && dl.buffer) rsAtt.push({ filename: rm.upload.file_name || 'document', mimeType: rm.upload.mime_type || dl.mimeType || 'application/octet-stream', content: dl.buffer.toString('base64') });
        }
      }
    } catch (e) { console.error('[AHPRA] reply attachment gather failed:', e.message); }
    // Resolve the last message's Message-ID for proper threading (best-effort).
    let rsInReplyTo = '';
    try {
      const tGmail = await getGmailClient(MONITORED_VA_EMAILS[0]);
      if (tGmail && rsThreadId) {
        const tThread = await tGmail.users.threads.get({ userId: MONITORED_VA_EMAILS[0], id: rsThreadId, format: 'metadata', metadataHeaders: ['Message-ID'] });
        const tMsgs = (tThread.data && Array.isArray(tThread.data.messages)) ? tThread.data.messages : [];
        const tLast = tMsgs[tMsgs.length - 1];
        const tMid = tLast && tLast.payload && Array.isArray(tLast.payload.headers) ? tLast.payload.headers.find(function (h) { return String(h.name).toLowerCase() === 'message-id'; }) : null;
        if (tMid) rsInReplyTo = tMid.value;
      }
    } catch (e) { /* threading is best-effort */ }
    const rsSubject = rsDraft.subject || ('Re: ' + (rsM.thread_subject || 'AHPRA notice'));
    const sent = await sendGmailEmail({
      from: MONITORED_VA_EMAILS[0], to: rsTo, subject: rsSubject,
      bodyText: rsDraft.body || rsM.detail || '', attachments: rsAtt,
      threadId: rsThreadId || undefined, inReplyTo: rsInReplyTo || undefined, caseId: rsTask.case_id
    });
    if (!sent || !sent.ok) { sendJson(res, 502, { ok: false, message: (sent && sent.error) || 'Could not send the email — copy the draft and send it in Gmail.' }); return; }
    rsM.sent_at = new Date().toISOString();
    rsM.sent_gmail_message_id = sent.gmailMessageId || '';
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(rsTaskId), {
      method: 'PATCH', body: { status: 'completed', completed_at: new Date().toISOString(), completed_by: adminCtx.email, metadata: rsM, updated_at: new Date().toISOString() }
    });
    await _logCaseEvent(rsTask.case_id, rsTaskId, 'completed', 'AHPRA reply sent from app', 'Sent to ' + rsTo + ' with ' + rsAtt.length + ' attachment(s).', adminCtx.email);
    sendJson(res, 200, { ok: true, attachments: rsAtt.length });
    return;
  }
```

- [ ] **Step 2: Verify**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo "server.js OK"
grep -n "ahpra/reply/send'\|sendGmailEmail({" server.js | head
```
Expect `server.js OK`; the route present once. Read the diff: admin-gated; only acts on `mode==='reply'`; never marks completed unless `sent.ok`; gracefully errors when Gmail not configured / no recipient.

- [ ] **Step 3: Commit (do NOT push)**
```bash
git add server.js
git commit -m "AHPRA s80: send combined reply to AHPRA from the app (threaded, with approved attachments)"
```

---

### Task 4: "Send to AHPRA" button + handler — admin.html

**Files:** Modify `pages/admin.html` — reply branch of `renderS80Active` (~line 2815-2820); click-handler block (~line 6231, near `data-s80-complete`).

**Interfaces:** Adds a `data-s80-ahpra-send` button + a delegated click handler that POSTs to `/api/admin/ahpra/reply/send`.

- [ ] **Step 1: Add the button**

In `renderS80Active`, in the `if(m.mode==='reply'){` branch, find the action-buttons line containing `data-s80-copy="`+...+`Copy draft</button><button type="button" data-s80-complete=`. Insert a "Send to AHPRA" button as the FIRST button in that row — change the start of that buttons `<div>` so it begins with:
```js
        html+='<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;"><button type="button" data-s80-ahpra-send="'+esc(t.id)+'" style="background:#16a34a;color:#fff;border:none;padding:7px 13px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;">📨 Send to AHPRA</button><button type="button" data-s80-copy="'+esc(t.id)+'" ';
```
(i.e. prepend the Send-to-AHPRA button before the existing `data-s80-copy` "Copy draft" button; keep "Copy draft" and "Mark sent" as fallbacks. The original line started `html+='<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;"><button type="button" data-s80-copy="'+esc(t.id)+'" ...` — you are inserting the Send button between the opening `<div...>` and the Copy button.)

- [ ] **Step 2: Add the click handler**

In the admin click-delegation block, immediately AFTER the `data-s80-complete` handler (the `var s80Comp=e.target.closest("[data-s80-complete]"); if(s80Comp){ ... }` block), add:
```js
      var s80Send=e.target.closest("[data-s80-ahpra-send]");
      if(s80Send){ e.preventDefault();
        if(!confirm('Send the combined reply to AHPRA now, with the approved files attached?'))return;
        var sid=s80Send.getAttribute("data-s80-ahpra-send"); s80Send.disabled=true; var ot=s80Send.textContent; s80Send.textContent='Sending…';
        try{ var r=await fetch('/api/admin/ahpra/reply/send',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({task_id:sid})}); var d=await r.json().catch(()=>({})); if(!d.ok){alert(d.message||'Send failed — copy the draft and send in Gmail.');s80Send.disabled=false;s80Send.textContent=ot;return;} }catch(err){alert('Send failed — copy the draft and send in Gmail.');s80Send.disabled=false;s80Send.textContent=ot;return;}
        await loadAll(true); return;
      }
```

- [ ] **Step 3: Verify**
```bash
grep -n "data-s80-ahpra-send" pages/admin.html
```
Expect 2 occurrences (button render + handler). Read `git diff`: button prepended in the reply branch; handler POSTs to /api/admin/ahpra/reply/send and only `loadAll` on success; Copy/Mark-sent untouched.

- [ ] **Step 4: Manual verification (no UI harness — report as manual)**

Manually (report as manual): with a bundle whose request items are all marked done (so the reply task exists), open the admin tray, click "Send to AHPRA", confirm the email sends on the thread with attachments and the task flips to completed; if Gmail isn't configured locally, confirm it shows the graceful "copy the draft" message and the task stays open.

- [ ] **Step 5: Commit (do NOT push)**
```bash
git add pages/admin.html
git commit -m "AHPRA s80 (admin): one-click 'Send to AHPRA' on the combined reply"
```

---

## Self-review (Phase 4 vs spec Part B)

- **Spec coverage:** AI upload pre-check → Task 1 (helper + advisory storage) + Task 2 (admin display); send reply from app with attachments + threading → Task 3 (endpoint) + Task 4 (button/handler). Auto-approve on confident match + auto-send with hold window → deferred to Phase 5 (documented). ✓
- **Placeholder scan:** all steps carry concrete code + verify commands. ✓
- **Type/name consistency:** `verifyS80FileMatch` → `metadata.upload.ai_match{matches,confidence,reason}` → admin `renderS80UploadAiMatch(up)` (reads `up.ai_match`). `POST /api/admin/ahpra/reply/send {task_id}` ↔ `data-s80-ahpra-send` handler. `sendGmailEmail`/`supabaseStorageDownloadObject`/`getGmailClient`/`MONITORED_VA_EMAILS`/`extractAiJsonObject`/`buildQualContentBlock` all confirmed to exist. ✓
- **Safety:** match check is advisory (never blocks upload) + budget-gated + no temperature; reply send is admin-gated, only `mode==='reply'`, never marks completed unless `sent.ok`, degrades gracefully without Gmail; one-click human-triggered (auto-send is Phase 5). ✓
