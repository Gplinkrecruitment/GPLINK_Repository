# Notes Section & Documents Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate notes into their own section on the Notes tab (out of the timeline), and add a Documents tab that lists all files from the GP's Google Drive folder with preview, full-page view, and upload.

**Architecture:** Three changes — (1) split `renderGpNotesPane` so notes appear in a dedicated NOTES section with the timeline showing only non-note events; (2) add a Documents tab to the subtabs bar and a new `renderGpDocumentsPane` function that fetches/caches Drive files, renders thumbnail cards, supports full-page overlay preview, and file upload; (3) add two new server endpoints (`GET /api/admin/drive/files`, `POST /api/admin/drive/upload`) and widen the Google Drive API scope from `drive.file` to `drive`.

**Tech Stack:** Vanilla JS/HTML (admin.html), Node.js (server.js), Google Drive API v3, Supabase

---

### Task 1: Widen Google Drive scope and add list-files endpoint

**Files:**
- Modify: `server.js:264` (Drive scope)
- Modify: `server.js:22719` (add new endpoints before tasks endpoint)

- [ ] **Step 1: Change Google Drive scope from `drive.file` to `drive`**

In `server.js:264`, change the scope in `getGoogleDriveClient()`:

```javascript
// Change from:
['https://www.googleapis.com/auth/drive.file']
// To:
['https://www.googleapis.com/auth/drive']
```

- [ ] **Step 2: Add `GET /api/admin/drive/files` endpoint**

Insert before the `// ── List tasks` comment (line ~22721) in `server.js`:

```javascript
  // ── List files in GP's Google Drive folder ──
  if (pathname === '/api/admin/drive/files' && req.method === 'GET') {
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    if (!isGoogleDriveConfigured()) { sendJson(res, 200, { ok: true, files: [], message: 'Google Drive not configured.' }); return; }
    const caseId = url.searchParams.get('case_id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing case_id.' }); return; }
    try {
      const caseRes = await supabaseDbRequest('registration_cases', 'select=google_drive_folder_id&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
      const folderId = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0].google_drive_folder_id : null;
      if (!folderId) { sendJson(res, 200, { ok: true, files: [] }); return; }
      const drive = await getGoogleDriveClient();
      const listRes = await drive.files.list({
        q: "'" + folderId + "' in parents and trashed = false",
        fields: 'files(id,name,mimeType,size,modifiedTime,thumbnailLink,webViewLink,webContentLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 100
      });
      sendJson(res, 200, { ok: true, files: listRes.data.files || [] });
    } catch (err) {
      console.error('[Drive] list files error:', err.message);
      sendJson(res, 500, { ok: false, message: 'Failed to list files.' });
    }
    return;
  }
```

- [ ] **Step 3: Add `POST /api/admin/drive/upload` endpoint**

Insert right after the list-files endpoint:

```javascript
  // ── Upload file to GP's Google Drive folder ──
  if (pathname === '/api/admin/drive/upload' && req.method === 'POST') {
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    if (!isGoogleDriveConfigured()) { sendJson(res, 503, { ok: false, message: 'Google Drive not configured.' }); return; }
    const caseId = url.searchParams.get('case_id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing case_id.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const fileName = body && typeof body.fileName === 'string' ? body.fileName.trim() : '';
    const fileData = body && typeof body.fileData === 'string' ? body.fileData : '';
    const mimeType = body && typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream';
    if (!fileName || !fileData) { sendJson(res, 400, { ok: false, message: 'Missing fileName or fileData.' }); return; }
    try {
      const caseRes = await supabaseDbRequest('registration_cases', 'select=google_drive_folder_id,gp_name,gp_email&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
      const caseRow = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0] : null;
      let folderId = caseRow ? caseRow.google_drive_folder_id : null;
      if (!folderId) {
        const nameParts = (caseRow && caseRow.gp_name ? caseRow.gp_name : 'Unknown').split(' ');
        folderId = await ensureGPDriveFolder(caseId, nameParts[0] || '', nameParts.slice(1).join(' ') || '');
      }
      if (!folderId) { sendJson(res, 500, { ok: false, message: 'Could not create Drive folder.' }); return; }
      const base64Match = fileData.match(/^data:[^;]*;base64,(.*)$/);
      const raw = base64Match ? base64Match[1] : fileData;
      const buffer = Buffer.from(raw, 'base64');
      const result = await uploadToGoogleDrive(folderId, fileName, buffer, mimeType);
      if (!result) { sendJson(res, 500, { ok: false, message: 'Upload failed.' }); return; }
      await _logCaseEvent(caseId, null, 'document_uploaded', 'Document uploaded: ' + fileName, null, adminCtx.email);
      sendJson(res, 200, { ok: true, file: result });
    } catch (err) {
      console.error('[Drive] upload error:', err.message);
      sendJson(res, 500, { ok: false, message: 'Upload failed.' });
    }
    return;
  }
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add Drive list-files and upload endpoints, widen scope to drive"
```

---

### Task 2: Separate notes from timeline in the Notes tab

**Files:**
- Modify: `pages/admin.html:2190-2207` (`renderGpNotesPane` function)

- [ ] **Step 1: Rewrite `renderGpNotesPane` to show notes in own section**

Replace the entire `renderGpNotesPane` function (lines 2190-2207) with:

```javascript
  function renderGpNotesPane(c){
    const cache=S.va.gpDetailCache[c.user_id]||{};
    const timeline=cache.timeline;
    if(!timeline)loadGpTimeline(c.user_id,c.id);
    const tickets=(S.va.dashboard&&S.va.dashboard.open_tickets)?S.va.dashboard.open_tickets.filter(t=>t.user_id===c.user_id):[];
    const notes=timeline?timeline.filter(ev=>ev.event_type==='note'):[];
    const otherEvents=timeline?timeline.filter(ev=>ev.event_type!=='note'):[];
    let h='';
    h+='<div class="inbox-section-title">Add a note</div>';
    h+='<textarea id="gpNoteInput" placeholder="Type a note\u2026" style="width:100%;min-height:60px;padding:8px;background:var(--bg2,#171a22);border:1px solid var(--border,#2a2f3a);border-radius:6px;color:var(--text,#e6e9f0);font-family:inherit;font-size:13px"></textarea>';
    h+='<button class="btn primary sm" data-add-note="'+esc(c.id)+'" style="margin-top:6px">Add note</button>';
    h+='<div class="inbox-section-title">Notes <span class="count">'+notes.length+'</span></div>';
    if(!notes.length)h+='<div class="empty">No notes yet.</div>';
    else h+=notes.map(function(ev){return '<div class="note-card"><div class="note-card-text">'+esc(ev.detail||ev.title||"")+'</div><div class="note-card-meta">'+esc(ev.actor||"")+' \u2022 '+fmtR(ev.created_at)+'</div></div>';}).join("");
    h+='<div class="inbox-section-title">Support tickets <span class="count">'+tickets.length+'</span></div>';
    if(!tickets.length)h+='<div class="empty">No open tickets.</div>';
    else h+=tickets.map(ticketCard).join("");
    h+='<div class="inbox-section-title">Timeline</div>';
    if(!timeline)h+='<div class="empty">Loading\u2026</div>';
    else if(!otherEvents.length)h+='<div class="empty">No activity yet.</div>';
    else h+=otherEvents.map(ev=>'<div class="todo-card" data-timeline-row="'+esc(ev.id||"")+'"><div class="todo-title">'+esc(ev.title||ev.event_type||"event")+'</div>'+(ev.detail?'<div class="todo-detail">'+esc(ev.detail)+'</div>':'')+'<div class="todo-detail" style="font-size:11px;color:var(--muted,#9aa3b2)">'+esc(ev.actor||"")+' \u2022 '+fmtR(ev.created_at)+'</div></div>').join("");
    return h;
  }
```

- [ ] **Step 2: Add `.note-card` CSS**

Add after the existing `.inbox-section-title` styles (around line 550 in the `<style>` block):

```css
.note-card{background:var(--bg2,#171a22);border:1px solid var(--border,#2a2f3a);border-left:3px solid var(--amber,#f59e0b);border-radius:8px;padding:12px 14px;margin-bottom:8px}
.note-card-text{font-size:13px;line-height:1.5;color:var(--text,#e6e9f0);white-space:pre-wrap}
.note-card-meta{font-size:11px;color:var(--muted,#9aa3b2);margin-top:6px}
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat: separate notes into own section on Notes tab"
```

---

### Task 3: Add Documents tab and rendering

**Files:**
- Modify: `pages/admin.html:2297-2303` (tab bar + pane selector)
- Modify: `pages/admin.html` (add `renderGpDocumentsPane` function after `loadGpTimeline`)
- Modify: `pages/admin.html` (add CSS for document cards, overlay, upload)
- Modify: `pages/admin.html` (add click handlers for documents)

- [ ] **Step 1: Add Documents tab to the subtabs bar**

In `renderDetail()`, replace the tab bar code (lines 2297-2303):

From:
```javascript
      const tab=S.gpsProfileTab||"tasks";
      const taskCount=(S.tasks||[]).filter(t=>t.case_id===c.id&&t.status!=="completed"&&t.status!=="complete").length;
      const tabsBar=`<div class="gp-subtabs">
        <div class="gp-subtab ${tab==="tasks"?"active":""}" data-gp-tab="tasks">Tasks <span class="subtab-count">${taskCount}</span></div>
        <div class="gp-subtab ${tab==="notes"?"active":""}" data-gp-tab="notes">Notes</div>
      </div>`;
      const paneHtml=tab==="tasks"?renderGpTasksPane(c):renderGpNotesPane(c);
```

To:
```javascript
      const tab=S.gpsProfileTab||"tasks";
      const taskCount=(S.tasks||[]).filter(t=>t.case_id===c.id&&t.status!=="completed"&&t.status!=="complete").length;
      const docCache=S.va.gpDetailCache[c.user_id]||{};
      const docCount=docCache.driveFiles?docCache.driveFiles.length:null;
      const tabsBar=`<div class="gp-subtabs">
        <div class="gp-subtab ${tab==="tasks"?"active":""}" data-gp-tab="tasks">Tasks <span class="subtab-count">${taskCount}</span></div>
        <div class="gp-subtab ${tab==="notes"?"active":""}" data-gp-tab="notes">Notes</div>
        <div class="gp-subtab ${tab==="documents"?"active":""}" data-gp-tab="documents">Documents${docCount!==null?' <span class="subtab-count">'+docCount+'</span>':''}</div>
      </div>`;
      const paneHtml=tab==="tasks"?renderGpTasksPane(c):tab==="notes"?renderGpNotesPane(c):renderGpDocumentsPane(c);
```

- [ ] **Step 2: Add `renderGpDocumentsPane` and `loadGpDriveFiles` functions**

Insert after the `loadGpTimeline` function (after line 2218):

```javascript
  function renderGpDocumentsPane(c){
    const cache=S.va.gpDetailCache[c.user_id]||{};
    const files=cache.driveFiles;
    if(files===undefined)loadGpDriveFiles(c.user_id,c.id);
    let h='';
    h+='<div class="inbox-section-title">Upload document</div>';
    h+='<div class="drive-upload-row">';
    h+='<label class="btn primary sm drive-upload-btn">Choose file\u2026<input type="file" data-drive-upload="'+esc(c.id)+'" style="position:absolute;inset:0;opacity:0;cursor:pointer" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.heic,.txt,.csv"></label>';
    h+='<span class="drive-upload-status" id="driveUploadStatus"></span>';
    h+='</div>';
    h+='<div class="inbox-section-title">Documents'+(files?' <span class="count">'+files.length+'</span>':'')+'</div>';
    if(!files)h+='<div class="empty">Loading\u2026</div>';
    else if(!files.length)h+='<div class="empty">No documents yet.</div>';
    else{
      h+='<div class="drive-files-grid">';
      h+=files.map(function(f){
        var icon=driveFileIcon(f.mimeType);
        var thumb=f.thumbnailLink?'<img src="'+esc(f.thumbnailLink)+'" class="drive-thumb" alt="">':'<div class="drive-thumb drive-thumb-icon">'+icon+'</div>';
        var size=f.size?formatFileSize(Number(f.size)):'';
        return '<div class="drive-file-card" data-drive-preview="'+esc(f.id)+'" data-drive-name="'+esc(f.name)+'" data-drive-mime="'+esc(f.mimeType||'')+'" data-drive-link="'+esc(f.webViewLink||'')+'">'
          +thumb
          +'<div class="drive-file-info">'
          +'<div class="drive-file-name" title="'+esc(f.name)+'">'+esc(f.name)+'</div>'
          +'<div class="drive-file-meta">'+size+(size?' \u2022 ':'')+fmtR(f.modifiedTime)+'</div>'
          +'</div>'
          +'</div>';
      }).join("");
      h+='</div>';
    }
    return h;
  }
  function driveFileIcon(mime){
    if(!mime)return '\uD83D\uDCC4';
    if(mime.indexOf('pdf')>-1)return '\uD83D\uDCC4';
    if(mime.indexOf('image')>-1)return '\uD83D\uDDBC\uFE0F';
    if(mime.indexOf('spreadsheet')>-1||mime.indexOf('excel')>-1||mime.indexOf('csv')>-1)return '\uD83D\uDCCA';
    if(mime.indexOf('document')>-1||mime.indexOf('word')>-1)return '\uD83D\uDCC3';
    return '\uD83D\uDCC4';
  }
  function formatFileSize(bytes){
    if(!bytes||bytes<=0)return '';
    if(bytes<1024)return bytes+'B';
    if(bytes<1048576)return Math.round(bytes/1024)+'KB';
    return (bytes/1048576).toFixed(1)+'MB';
  }
  async function loadGpDriveFiles(userId,caseId){
    try{
      const r=await fetch("/api/admin/drive/files?case_id="+encodeURIComponent(caseId),{credentials:"same-origin"});
      const d=await r.json().catch(()=>({}));
      S.va.gpDetailCache[userId]=S.va.gpDetailCache[userId]||{};
      S.va.gpDetailCache[userId].driveFiles=d&&d.ok&&Array.isArray(d.files)?d.files:[];
      if(S.view==="gps"&&S.selectedCaseId===caseId&&S.gpsProfileTab==="documents")renderDetail();
    }catch(err){console.error("[VA] loadGpDriveFiles failed",err);}
  }
```

- [ ] **Step 3: Add document CSS**

Add after the `.note-card-meta` CSS added in Task 2:

```css
.drive-upload-row{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.drive-upload-btn{position:relative;overflow:hidden;cursor:pointer}
.drive-upload-status{font-size:12px;color:var(--muted,#9aa3b2)}
.drive-files-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.drive-file-card{background:var(--bg2,#171a22);border:1px solid var(--border,#2a2f3a);border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color .15s,transform .12s}
.drive-file-card:hover{border-color:var(--blue);transform:translateY(-1px)}
.drive-thumb{width:100%;height:120px;object-fit:cover;background:var(--bg3,#1f2330);display:flex;align-items:center;justify-content:center}
.drive-thumb-icon{font-size:36px}
.drive-file-info{padding:10px}
.drive-file-name{font-size:12px;font-weight:700;color:var(--text,#e6e9f0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drive-file-meta{font-size:10px;color:var(--muted,#9aa3b2);margin-top:3px}
.drive-overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center}
.drive-overlay-bar{width:100%;display:flex;align-items:center;justify-content:space-between;padding:12px 20px;flex-shrink:0}
.drive-overlay-name{font-size:14px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.drive-overlay-actions{display:flex;gap:8px}
.drive-overlay-close{background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:8px;padding:6px 16px;font-size:13px;font-weight:700;cursor:pointer}
.drive-overlay-close:hover{background:rgba(255,255,255,.25)}
.drive-overlay-open{background:var(--blue);color:#fff;border:none;border-radius:8px;padding:6px 16px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none}
.drive-overlay-open:hover{opacity:.9}
.drive-overlay-body{flex:1;width:100%;display:flex;align-items:center;justify-content:center;overflow:auto;padding:10px}
.drive-overlay-body iframe{width:90vw;height:85vh;border:none;border-radius:8px;background:#fff}
.drive-overlay-body img{max-width:90vw;max-height:85vh;object-fit:contain;border-radius:8px}
```

- [ ] **Step 4: Add click handlers for document preview, upload, and overlay close**

Find the click handler section (around line 3589 where `data-add-note` is handled) and add after it:

```javascript
      /* Drive document preview overlay */
      const dpc=e.target.closest("[data-drive-preview]");
      if(dpc){
        const name=dpc.getAttribute("data-drive-name")||"Document";
        const mime=dpc.getAttribute("data-drive-mime")||"";
        const link=dpc.getAttribute("data-drive-link")||"";
        if(!link)return;
        let bodyContent;
        if(mime.indexOf("image")>-1){
          bodyContent='<img src="'+esc(link)+'" alt="'+esc(name)+'">';
        }else{
          bodyContent='<iframe src="'+esc(link)+'"></iframe>';
        }
        const overlay=document.createElement("div");
        overlay.className="drive-overlay";
        overlay.innerHTML='<div class="drive-overlay-bar"><div class="drive-overlay-name">'+esc(name)+'</div><div class="drive-overlay-actions"><a class="drive-overlay-open" href="'+esc(link)+'" target="_blank" rel="noopener">Open in Drive</a><button class="drive-overlay-close" data-drive-overlay-close>Close</button></div></div><div class="drive-overlay-body">'+bodyContent+'</div>';
        document.body.appendChild(overlay);
        return;
      }
      if(e.target.closest("[data-drive-overlay-close]")){
        const ov=e.target.closest(".drive-overlay");
        if(ov)ov.remove();
        return;
      }
```

Also add an Escape key handler. Find the existing `keydown` listener or add one inside the `DOMContentLoaded` block:

```javascript
      document.addEventListener("keydown",function(e){
        if(e.key==="Escape"){
          var ov=document.querySelector(".drive-overlay");
          if(ov)ov.remove();
        }
      });
```

- [ ] **Step 5: Add file upload handler**

Add inside the `DOMContentLoaded` block, in the delegated event handler or as a separate `change` listener:

```javascript
      document.addEventListener("change",function(e){
        const uploadInput=e.target.closest("[data-drive-upload]");
        if(!uploadInput)return;
        const caseId=uploadInput.getAttribute("data-drive-upload");
        const file=uploadInput.files&&uploadInput.files[0];
        if(!file||!caseId)return;
        const status=document.getElementById("driveUploadStatus");
        if(status)status.textContent="Uploading\u2026";
        const reader=new FileReader();
        reader.onload=async function(){
          try{
            const r=await fetch("/api/admin/drive/upload?case_id="+encodeURIComponent(caseId),{
              method:"POST",credentials:"same-origin",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({fileName:file.name,fileData:reader.result,mimeType:file.type||"application/octet-stream"})
            });
            const d=await r.json().catch(()=>({}));
            if(d&&d.ok){
              if(status)status.textContent="\u2713 Uploaded";
              const c=S.cases.find(x=>x.id===caseId);
              if(c&&S.va.gpDetailCache[c.user_id])delete S.va.gpDetailCache[c.user_id].driveFiles;
              renderDetail();
            }else{
              if(status)status.textContent="\u2717 "+(d.message||"Upload failed");
            }
          }catch(err){
            console.error("[VA] Drive upload failed:",err);
            if(status)status.textContent="\u2717 Upload failed";
          }
        };
        reader.readAsDataURL(file);
      });
```

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Documents tab with Drive file grid, preview overlay, and upload"
```

---

### Task 4: Final integration commit and push

- [ ] **Step 1: Verify all three tabs render correctly**

Open `admin.mygplink.com.au/pages/admin.html`, select a GP, click Tasks, Notes, Documents tabs. Confirm:
- Notes tab shows notes in their own section above timeline
- Documents tab shows Drive files as thumbnail cards
- Clicking a card opens the full-page overlay
- Upload works

- [ ] **Step 2: Push to remote**

```bash
git push origin main
```
