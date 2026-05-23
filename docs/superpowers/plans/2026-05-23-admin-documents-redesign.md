# Admin Documents Tab Redesign + GP Reset

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the admin Documents tab to show 3 categorized sections (Direct to AHPRA, Prepared by Candidate, Prepared by GP LINK) with placeholder cards, and reset smithmiller1234@gmail.com's data.

**Architecture:** Add a new server endpoint `GET /api/admin/gp-documents` that returns all document data pre-categorized (user_state, user_documents, practice_doc_ops, Drive files). Rewrite the admin frontend `renderGpDocumentsPane()` to render 3 collapsible sections. Enhance the existing `/api/admin/reset-gp` endpoint to also clear `user_documents` and `practice_doc_ops` records.

**Tech Stack:** Vanilla JS, Node.js server.js, Supabase, Google Drive API

---

### Task 1: Enhance reset endpoint and clear smithmiller1234@gmail.com

**Files:**
- Modify: `server.js` (lines 20273-20281, add user_documents + practice_doc_ops deletion)

The existing `/api/admin/reset-gp` endpoint clears Drive files, tasks, task_messages, task_documents, and user_state — but doesn't touch `user_documents` or `practice_doc_ops`. Add those two deletions.

- [ ] **Step 1: Add user_documents deletion to the reset endpoint**

In `server.js`, after the existing step 6 (delete task_documents, line 20281) and before step 7 (clear user_state, line 20283), insert two new deletion blocks:

```javascript
      // 6b. Delete all user_documents for that user
      await supabaseDbRequest('user_documents', 'user_id=eq.' + encodeURIComponent(resetUserId), {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      });

      // 6c. Delete all practice_doc_ops for that case
      await supabaseDbRequest('practice_doc_ops', 'case_id=eq.' + encodeURIComponent(resetCaseId), {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      });
```

Insert these two blocks between line 20281 (`});` closing the task_documents DELETE) and line 20283 (`// 7. Clear gp_prepared_docs...`).

- [ ] **Step 2: Also clear gp_documents_prep in the state reset**

In the same endpoint, around line 20287 where `resetState.gp_prepared_docs = {};` is set, also clear `gp_documents_prep`:

```javascript
        resetState.gp_prepared_docs = {};
        resetState.gp_ahpra_progress = {};
        resetState.gp_documents_prep = {};
```

Add `resetState.gp_documents_prep = {};` right after `resetState.gp_ahpra_progress = {};`.

- [ ] **Step 3: Commit the reset endpoint changes**

```bash
git add server.js
git commit -m "fix: reset endpoint now clears user_documents, practice_doc_ops, and gp_documents_prep"
```

- [ ] **Step 4: Call the reset endpoint for smithmiller1234@gmail.com**

Use curl from the CLI to hit the reset endpoint. You'll need the admin session cookie. Instead, find the admin session check and call the endpoint directly with a Supabase query approach — or more practically, run the reset logic inline via a Node.js one-liner script:

```bash
node -e "
const http = require('http');
const data = JSON.stringify({ email: 'smithmiller1234@gmail.com' });
const req = http.request({
  hostname: 'admin.mcgplink.com.au',
  path: '/api/admin/reset-gp',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': 'ADMIN_SESSION_COOKIE_HERE'
  }
}, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => console.log(res.statusCode, body));
});
req.write(data);
req.end();
"
```

**Alternative:** If no admin session is available, run the reset directly on the production DB via a temporary script that uses the Supabase service role key from env vars. If neither approach is practical right now, skip this step — the endpoint is ready and can be called from the admin UI later.

---

### Task 2: Create GET /api/admin/gp-documents endpoint

**Files:**
- Modify: `server.js` (insert new endpoint near the existing `/api/admin/drive/files` at line 25177)

This endpoint returns all document data for a GP, pre-categorized into three sections.

- [ ] **Step 1: Add the endpoint**

In `server.js`, insert the following endpoint just BEFORE the existing `if (pathname === '/api/admin/drive/files'` block (line 25177). Find the line and insert above it:

```javascript
  /* ── Admin: Categorized GP Documents ── */
  if (pathname === '/api/admin/gp-documents' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    var gdAdminCtx = requireAdminSession(req, res);
    if (!gdAdminCtx) return;
    var gdCaseId = url.searchParams.get('case_id');
    if (!gdCaseId) { sendJson(res, 400, { ok: false, message: 'Missing case_id.' }); return; }

    try {
      // 1. Get case + user info
      var gdCaseRes = await supabaseDbRequest('registration_cases', 'select=id,user_id,google_drive_folder_id,stage&id=eq.' + encodeURIComponent(gdCaseId) + '&limit=1');
      var gdCase = gdCaseRes.ok && Array.isArray(gdCaseRes.data) && gdCaseRes.data[0] ? gdCaseRes.data[0] : null;
      if (!gdCase) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }
      var gdUserId = gdCase.user_id;

      // 2. Get user's country from state or profile
      var gdStateRes = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(gdUserId) + '&limit=1');
      var gdUserState = gdStateRes.ok && Array.isArray(gdStateRes.data) && gdStateRes.data[0] && typeof gdStateRes.data[0].state === 'object' ? gdStateRes.data[0].state : {};
      var gdProfRes = await supabaseDbRequest('user_profiles', 'select=registration_country&user_id=eq.' + encodeURIComponent(gdUserId) + '&limit=1');
      var gdProf = gdProfRes.ok && Array.isArray(gdProfRes.data) && gdProfRes.data[0] ? gdProfRes.data[0] : {};
      var gdCountry = (gdProf.registration_country || gdUserState.gp_selected_country || 'uk').toLowerCase();

      // 3. Build document template list for this country
      var gdShared = GP_DOCUMENT_META.shared || [];
      var gdCountryDocs = GP_DOCUMENT_META[gdCountry] || [];
      var gdAllDocs = gdShared.concat(gdCountryDocs);

      // 4. Get user_documents from DB
      var gdNormalizedCountry = gdCountry.toUpperCase();
      var gdUserDocsRes = await supabaseDbRequest('user_documents', 'select=*&user_id=eq.' + encodeURIComponent(gdUserId) + '&country_code=eq.' + encodeURIComponent(gdNormalizedCountry));
      var gdUserDocs = gdUserDocsRes.ok && Array.isArray(gdUserDocsRes.data) ? gdUserDocsRes.data : [];
      var gdUserDocsByKey = {};
      gdUserDocs.forEach(function(d) { if (d && d.document_key) gdUserDocsByKey[d.document_key] = d; });

      // 5. Get user_state document prep status
      var gdDocPrep = gdUserState.gp_documents_prep || gdUserState.gp_prepared_docs || {};
      var gdDocPrepDocs = gdDocPrep.docs || gdDocPrep || {};

      // 6. Get practice_doc_ops
      var gdPracticeOps = await _ensurePracticeDocOps(gdCaseId);

      // 7. Get Drive files
      var gdDriveFiles = [];
      if (gdCase.google_drive_folder_id && isGoogleDriveConfigured()) {
        try {
          var gdDrive = await getGoogleDriveClient();
          if (gdDrive) {
            var gdDriveRes = await gdDrive.files.list({
              q: "'" + gdCase.google_drive_folder_id + "' in parents and trashed = false",
              fields: 'files(id,name,mimeType,size,modifiedTime,thumbnailLink,webViewLink)',
              orderBy: 'modifiedTime desc', pageSize: 100
            });
            gdDriveFiles = gdDriveRes.data.files || [];
          }
        } catch (gdDriveErr) { console.error('[gp-documents] Drive error:', gdDriveErr.message); }
      }

      // 8. Get task_documents with Drive file IDs for practice_pack_child tasks
      var gdTaskDocsRes = await supabaseDbRequest('registration_tasks',
        'select=id,related_document_key,google_drive_file_id&case_id=eq.' + encodeURIComponent(gdCaseId) + '&task_type=eq.practice_pack_child');
      var gdTaskDocs = gdTaskDocsRes.ok && Array.isArray(gdTaskDocsRes.data) ? gdTaskDocsRes.data : [];
      var gdDriveIdToDocKey = {};
      gdTaskDocs.forEach(function(t) {
        if (t.google_drive_file_id && t.related_document_key) gdDriveIdToDocKey[t.google_drive_file_id] = t.related_document_key;
      });

      // Also check task_documents table for Drive file IDs
      var gdTaskDocFilesRes = await supabaseDbRequest('task_documents',
        'select=google_drive_file_id,task_id&case_id=eq.' + encodeURIComponent(gdCaseId) + '&is_current=eq.true&google_drive_file_id=neq.');
      var gdTaskDocFiles = gdTaskDocFilesRes.ok && Array.isArray(gdTaskDocFilesRes.data) ? gdTaskDocFilesRes.data : [];
      // Build task_id -> document_key map from the tasks we already fetched
      var gdTaskIdToDocKey = {};
      gdTaskDocs.forEach(function(t) { if (t.id && t.related_document_key) gdTaskIdToDocKey[t.id] = t.related_document_key; });
      gdTaskDocFiles.forEach(function(td) {
        if (td.google_drive_file_id && td.task_id && gdTaskIdToDocKey[td.task_id]) {
          gdDriveIdToDocKey[td.google_drive_file_id] = gdTaskIdToDocKey[td.task_id];
        }
      });

      // 9. Categorize
      var gdMatchedDriveIds = new Set();
      var gdDirectToAhpra = [];
      var gdPreparedByCandidate = [];
      var gdPreparedByGpLink = [];

      // Direct to AHPRA + Prepared by Candidate
      gdAllDocs.forEach(function(doc) {
        var userDoc = gdUserDocsByKey[doc.key];
        var stateDoc = gdDocPrepDocs[doc.key];
        var status = 'pending';
        if (userDoc) {
          status = userDoc.status || 'uploaded';
        } else if (stateDoc) {
          status = stateDoc.status || (stateDoc.uploaded ? 'uploaded' : (stateDoc.requested ? 'requested' : 'pending'));
        }
        var entry = { key: doc.key, label: doc.label, source: doc.source, status: status };
        if (userDoc) {
          entry.file_name = userDoc.file_name || '';
          entry.file_url = userDoc.file_url || '';
          entry.updated_at = userDoc.updated_at || '';
        }
        if (doc.source === 'institution_docs') gdDirectToAhpra.push(entry);
        else if (doc.source === 'prepared_by_you') gdPreparedByCandidate.push(entry);
      });

      // Prepared by GP LINK
      var gdOpsMap = {};
      gdPracticeOps.forEach(function(op) { if (op && op.document_key) gdOpsMap[op.document_key] = op; });

      GP_LINK_DOCUMENT_META.forEach(function(doc) {
        var ops = gdOpsMap[doc.key] || { ops_status: 'not_requested' };
        var driveFile = null;
        // Find matching Drive file by document key
        for (var i = 0; i < gdDriveFiles.length; i++) {
          if (gdDriveIdToDocKey[gdDriveFiles[i].id] === doc.key) {
            driveFile = gdDriveFiles[i];
            gdMatchedDriveIds.add(gdDriveFiles[i].id);
            break;
          }
        }
        // Fallback: match by filename containing the document label
        if (!driveFile) {
          var labelLower = doc.label.toLowerCase().replace(/[^a-z0-9]/g, '');
          for (var j = 0; j < gdDriveFiles.length; j++) {
            var nameLower = (gdDriveFiles[j].name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (nameLower.indexOf(labelLower) > -1 || (doc.key === 'sppa_00' && nameLower.indexOf('sppa') > -1)) {
              driveFile = gdDriveFiles[j];
              gdMatchedDriveIds.add(gdDriveFiles[j].id);
              break;
            }
          }
        }
        gdPreparedByGpLink.push({
          key: doc.key, label: doc.label,
          ops_status: ops.ops_status || 'not_requested',
          ops_id: ops.id || null,
          drive_file: driveFile
        });
      });

      // Other unmatched Drive files
      var gdOtherFiles = gdDriveFiles.filter(function(f) { return !gdMatchedDriveIds.has(f.id); });

      sendJson(res, 200, {
        ok: true,
        country: gdCountry,
        directToAhpra: gdDirectToAhpra,
        preparedByCandidate: gdPreparedByCandidate,
        preparedByGpLink: gdPreparedByGpLink,
        otherFiles: gdOtherFiles
      });
    } catch (gdErr) {
      console.error('[gp-documents] Error:', gdErr.message);
      sendJson(res, 500, { ok: false, message: 'Failed to load documents.' });
    }
    return;
  }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add GET /api/admin/gp-documents endpoint for categorized document view"
```

---

### Task 3: Rewrite admin Documents tab frontend

**Files:**
- Modify: `pages/admin.html` (lines 625-667 CSS, lines 2325-2362 renderGpDocumentsPane/renderDriveFilesList, line 2500-2511 loadGpDriveFiles)

Replace the flat Drive file grid with 3 categorized sections. Keep the existing upload button and Drive preview overlay intact.

- [ ] **Step 1: Add CSS for the 3-section document layout**

In `pages/admin.html`, find the existing `.drive-files-grid` CSS block (line 639). Add the following NEW styles right after `.drive-file-meta` (line 646), before `.drive-overlay` (line 647):

```css
.doc-section{margin-bottom:20px}
.doc-section-header{display:flex;align-items:center;justify-content:space-between;margin:18px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border,#2a2f3a)}
.doc-section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#9aa3b2)}
.doc-section-count{font-size:11px;color:var(--muted,#9aa3b2)}
.doc-section-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.doc-placeholder-card{background:var(--bg2,#171a22);border:1px dashed var(--border,#2a2f3a);border-radius:10px;overflow:hidden;min-height:80px}
.doc-placeholder-card.has-file{border-style:solid;cursor:pointer;transition:border-color .15s,transform .12s}
.doc-placeholder-card.has-file:hover{border-color:var(--blue);transform:translateY(-1px)}
.doc-placeholder-thumb{width:100%;height:100px;object-fit:cover;background:var(--bg3,#1f2330);display:flex;align-items:center;justify-content:center;font-size:32px;color:var(--muted,#9aa3b2)}
.doc-placeholder-info{padding:10px}
.doc-placeholder-label{font-size:12px;font-weight:700;color:var(--text,#e6e9f0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc-placeholder-status{display:inline-block;margin-top:4px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.03em}
.doc-placeholder-status.s-pending{background:var(--bg3,#1f2330);color:var(--muted,#9aa3b2)}
.doc-placeholder-status.s-requested{background:#1e3a5f;color:#60a5fa}
.doc-placeholder-status.s-uploaded,.doc-placeholder-status.s-received{background:#14532d;color:#4ade80}
.doc-placeholder-status.s-approved,.doc-placeholder-status.s-completed,.doc-placeholder-status.s-ready_for_gp{background:#166534;color:#22c55e}
.doc-placeholder-status.s-under_review,.doc-placeholder-status.s-awaiting_practice{background:#713f12;color:#fbbf24}
.doc-placeholder-status.s-rejected,.doc-placeholder-status.s-needs_correction{background:#7f1d1d;color:#f87171}
.doc-placeholder-status.s-not_requested{background:var(--bg3,#1f2330);color:var(--muted,#9aa3b2)}
.doc-placeholder-status.s-action_required{background:#7f1d1d;color:#f87171}
.doc-placeholder-meta{font-size:10px;color:var(--muted,#9aa3b2);margin-top:3px}
```

- [ ] **Step 2: Replace renderGpDocumentsPane function**

Replace the entire `renderGpDocumentsPane` function (lines 2325-2338) and `renderDriveFilesList` function (lines 2340-2362) with:

```javascript
  function renderGpDocumentsPane(c){
    var cache=S.va.gpDetailCache[c.user_id]||{};
    var gpDocs=cache.gpDocuments;
    if(gpDocs===undefined)loadGpDocuments(c.user_id,c.id);
    var h='';
    h+='<div class="inbox-section-title">Upload document</div>';
    h+='<div class="drive-upload-row">';
    h+='<label class="btn primary sm drive-upload-btn">Choose file\u2026<input type="file" data-drive-upload="'+esc(c.id)+'" style="position:absolute;inset:0;opacity:0;cursor:pointer" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.heic,.txt,.csv"></label>';
    h+='<span class="drive-upload-status" id="driveUploadStatus"></span>';
    h+='</div>';
    h+='<div id="driveFilesList">';
    h+=renderCategorizedDocuments(gpDocs);
    h+='</div>';
    return h;
  }

  function renderCategorizedDocuments(gpDocs){
    if(!gpDocs)return '<div class="empty">Loading\u2026</div>';
    var h='';

    // Section 1: Direct to AHPRA
    var ahpra=gpDocs.directToAhpra||[];
    var ahpraCount=ahpra.filter(function(d){return d.status!=='pending';}).length;
    h+='<div class="doc-section">';
    h+='<div class="doc-section-header"><span class="doc-section-title">Direct to AHPRA</span><span class="doc-section-count">'+ahpraCount+' / '+ahpra.length+'</span></div>';
    h+='<div class="doc-section-grid">';
    if(!ahpra.length)h+='<div class="empty">No documents in this category.</div>';
    ahpra.forEach(function(doc){
      h+=renderDocPlaceholderCard(doc,doc.status);
    });
    h+='</div></div>';

    // Section 2: Prepared by Candidate
    var candidate=gpDocs.preparedByCandidate||[];
    var candCount=candidate.filter(function(d){return d.status!=='pending';}).length;
    h+='<div class="doc-section">';
    h+='<div class="doc-section-header"><span class="doc-section-title">Prepared by Candidate</span><span class="doc-section-count">'+candCount+' / '+candidate.length+'</span></div>';
    h+='<div class="doc-section-grid">';
    if(!candidate.length)h+='<div class="empty">No documents in this category.</div>';
    candidate.forEach(function(doc){
      h+=renderDocPlaceholderCard(doc,doc.status);
    });
    h+='</div></div>';

    // Section 3: Prepared by GP LINK
    var gplink=gpDocs.preparedByGpLink||[];
    var gplinkCount=gplink.filter(function(d){return d.ops_status==='completed'||d.ops_status==='ready_for_gp';}).length;
    h+='<div class="doc-section">';
    h+='<div class="doc-section-header"><span class="doc-section-title">Prepared by GP LINK</span><span class="doc-section-count">'+gplinkCount+' / '+gplink.length+'</span></div>';
    h+='<div class="doc-section-grid">';
    gplink.forEach(function(doc){
      h+=renderGpLinkDocCard(doc);
    });
    h+='</div></div>';

    // Section 4: Other Files (unmatched Drive files)
    var other=gpDocs.otherFiles||[];
    if(other.length){
      h+='<div class="doc-section">';
      h+='<div class="doc-section-header"><span class="doc-section-title">Other Files</span><span class="doc-section-count">'+other.length+'</span></div>';
      h+='<div class="drive-files-grid">';
      other.forEach(function(f){
        var icon=driveFileIcon(f.mimeType);
        var thumb=f.thumbnailLink?'<img src="'+esc(f.thumbnailLink)+'" class="drive-thumb" alt="">':'<div class="drive-thumb drive-thumb-icon">'+icon+'</div>';
        var size=f.size?formatFileSize(Number(f.size)):'';
        h+='<div class="drive-file-card" data-drive-preview="'+esc(f.id)+'" data-drive-name="'+esc(f.name)+'" data-drive-mime="'+esc(f.mimeType||'')+'" data-drive-link="'+esc(f.webViewLink||'')+'">'
          +thumb
          +'<div class="drive-file-info">'
          +'<div class="drive-file-name" title="'+esc(f.name)+'">'+esc(f.name)+'</div>'
          +'<div class="drive-file-meta">'+size+(size?' \u2022 ':'')+fmtR(f.modifiedTime)+'</div>'
          +'</div></div>';
      });
      h+='</div></div>';
    }

    return h;
  }

  function docStatusLabel(status){
    var map={pending:'Pending',requested:'Requested',uploaded:'Uploaded',under_review:'Under Review',approved:'Approved',accepted:'Accepted',rejected:'Rejected',action_required:'Action Required',not_requested:'Not Requested',awaiting_practice:'Awaiting Practice',received:'Received',needs_correction:'Needs Correction',ready_for_gp:'Ready',completed:'Completed'};
    return map[status]||status||'Pending';
  }

  function renderDocPlaceholderCard(doc,status){
    var hasFile=!!doc.file_name||!!doc.file_url;
    var cls='doc-placeholder-card'+(hasFile?' has-file':'');
    var statusCls='s-'+(status||'pending');
    var thumbHtml='<div class="doc-placeholder-thumb">\uD83D\uDCC4</div>';
    var metaHtml='';
    if(doc.file_name){
      metaHtml='<div class="doc-placeholder-meta">'+esc(doc.file_name)+'</div>';
    }
    if(doc.updated_at){
      metaHtml+='<div class="doc-placeholder-meta">'+fmtR(doc.updated_at)+'</div>';
    }
    return '<div class="'+cls+'">'
      +thumbHtml
      +'<div class="doc-placeholder-info">'
      +'<div class="doc-placeholder-label" title="'+esc(doc.label)+'">'+esc(doc.label)+'</div>'
      +'<span class="doc-placeholder-status '+statusCls+'">'+docStatusLabel(status)+'</span>'
      +metaHtml
      +'</div></div>';
  }

  function renderGpLinkDocCard(doc){
    var df=doc.drive_file;
    var hasFile=!!df;
    var cls='doc-placeholder-card'+(hasFile?' has-file':'');
    var status=doc.ops_status||'not_requested';
    var statusCls='s-'+status;
    var thumbHtml;
    if(df&&df.thumbnailLink){
      thumbHtml='<img src="'+esc(df.thumbnailLink)+'" class="doc-placeholder-thumb" alt="" style="object-fit:cover">';
    }else if(df){
      thumbHtml='<div class="doc-placeholder-thumb">'+driveFileIcon(df.mimeType)+'</div>';
    }else{
      thumbHtml='<div class="doc-placeholder-thumb">\uD83D\uDCC4</div>';
    }
    var metaHtml='';
    if(df){
      var size=df.size?formatFileSize(Number(df.size)):'';
      metaHtml='<div class="doc-placeholder-meta">'+size+(size?' \u2022 ':'')+fmtR(df.modifiedTime)+'</div>';
    }
    var driveAttrs=df?' data-drive-preview="'+esc(df.id)+'" data-drive-name="'+esc(df.name)+'" data-drive-mime="'+esc(df.mimeType||'')+'" data-drive-link="'+esc(df.webViewLink||'')+'"':'';
    return '<div class="'+cls+'"'+driveAttrs+'>'
      +thumbHtml
      +'<div class="doc-placeholder-info">'
      +'<div class="doc-placeholder-label" title="'+esc(doc.label)+'">'+esc(doc.label)+'</div>'
      +'<span class="doc-placeholder-status '+statusCls+'">'+docStatusLabel(status)+'</span>'
      +metaHtml
      +'</div></div>';
  }
```

- [ ] **Step 3: Replace loadGpDriveFiles with loadGpDocuments**

Replace the `loadGpDriveFiles` function (lines 2500-2511) with a new function that calls the new endpoint. Keep `loadGpDriveFiles` as a thin wrapper for backwards compatibility (the upload handler calls it to refresh):

```javascript
  async function loadGpDocuments(userId,caseId){
    try{
      var r=await fetch("/api/admin/gp-documents?case_id="+encodeURIComponent(caseId),{credentials:"same-origin"});
      var d=await r.json().catch(function(){return {};});
      S.va.gpDetailCache[userId]=S.va.gpDetailCache[userId]||{};
      S.va.gpDetailCache[userId].gpDocuments=d&&d.ok?d:{ directToAhpra:[], preparedByCandidate:[], preparedByGpLink:[], otherFiles:[] };
      // Also cache Drive files count for the tab badge
      var totalFiles=0;
      if(d&&d.ok){
        totalFiles=(d.preparedByCandidate||[]).filter(function(x){return x.file_name;}).length+(d.preparedByGpLink||[]).filter(function(x){return x.drive_file;}).length+(d.otherFiles||[]).length;
      }
      S.va.gpDetailCache[userId].driveFiles=new Array(totalFiles);
      var listEl=document.getElementById("driveFilesList");
      if(listEl&&S.view==="gps"&&S.selectedCaseId===caseId&&S.gpsProfileTab==="documents"){
        listEl.innerHTML=renderCategorizedDocuments(S.va.gpDetailCache[userId].gpDocuments);
      }
    }catch(err){console.error("[VA] loadGpDocuments failed",err);}
  }

  async function loadGpDriveFiles(userId,caseId){
    // Redirect to the new categorized loader
    return loadGpDocuments(userId,caseId);
  }
```

- [ ] **Step 4: Update the Documents tab badge count**

In the tab bar rendering (around line 2589-2599), find where `docCount` is used. The current code reads `docCache.driveFiles.length`. Since we now set `driveFiles` as an array with the total count, this should still work. But update to be more accurate if needed:

Find the line (around 2592):
```javascript
const docCount=docCache.driveFiles?docCache.driveFiles.length:null;
```

Replace with:
```javascript
const docCount=docCache.driveFiles?docCache.driveFiles.length:(docCache.gpDocuments?'':null);
```

This keeps the count badge working. If gpDocuments is loaded but there are no files, it shows nothing instead of a spinner.

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat: admin Documents tab split into 3 sections (AHPRA, Candidate, GP LINK) with placeholders"
```

---

### Task 4: Deploy and verify

- [ ] **Step 1: Push all changes**

```bash
git push origin main
```

- [ ] **Step 2: Deploy via Vercel CLI**

```bash
vercel --prod
```

- [ ] **Step 3: Verify in the admin panel**

Navigate to the admin panel, select a GP with documents, click the Documents tab, and confirm:
1. Three sections are visible: "Direct to AHPRA", "Prepared by Candidate", "Prepared by GP LINK"
2. GP LINK section shows 5 placeholder cards (SPPA-00, Section G, Position Description, Offer/Contract, Supervisor CV) with status badges
3. Upload button still works
4. Drive file preview still works for cards with files
5. "Other Files" section shows unmatched Drive files

- [ ] **Step 4: Reset smithmiller1234@gmail.com**

From the admin panel, trigger the reset for smithmiller1234@gmail.com (or call the endpoint directly). Confirm:
1. Google Drive folder is cleared
2. Documents tab shows all placeholders with "Pending" / "Not Requested" status
3. New practice pack tasks are created
4. Registration journey is reset properly
