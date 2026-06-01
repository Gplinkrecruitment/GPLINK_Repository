# PDF.js Inline SPPA Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw field-name text editor with a visual PDF editor that renders the SPPA-00 in-browser with editable form fields overlaid on the actual document pages.

**Architecture:** A standalone HTML page (`pages/pdf-editor.html`) loads PDF.js from CDN, renders each PDF page to a canvas, and manually positions HTML form inputs over the canvas using annotation coordinate data from `page.getAnnotations()`. The page communicates with the parent admin page via `postMessage`. The existing server endpoints (`/sppa-pdf`, `/sppa-save-fields`) handle PDF fetching and saving.

**Tech Stack:** PDF.js 4.x (CDN), vanilla HTML/JS/CSS, existing Express endpoints in `server.js`

---

### Task 1: Fix `/sppa-pdf` endpoint to resolve AHPRA amendment task IDs

**Files:**
- Modify: `server.js:30193-30210`

The `/sppa-pdf` endpoint queries `task_documents` by task_id directly, but AHPRA amendment tasks have a different task_id than the SPPA task. The `/sppa-form-fields` endpoint (line 30655) already resolves this via `case_id` — apply the same pattern here.

- [ ] **Step 1: Add case_id fallback to `/sppa-pdf`**

In `server.js`, replace the current `/sppa-pdf` handler (lines 30193-30210) with:

```javascript
  // ── Preview SPPA-00 PDF (from task_documents) ──
  if (req.method === 'GET' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-pdf')) {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const taskId = pathname.split('/')[5];

    // Try direct task_id first
    var docRes = await supabaseDbRequest('task_documents',
      'select=attachment_url&task_id=eq.' + encodeURIComponent(taskId) + '&is_current=eq.true&category=neq.alt_supervisor_cv&limit=1');
    var doc = docRes.ok && docRes.data && docRes.data[0] ? docRes.data[0] : null;

    // Fallback: resolve SPPA task via case_id (for AHPRA amendment tasks)
    if (!doc || !doc.attachment_url) {
      var taskRes = await supabaseDbRequest('registration_tasks',
        'select=case_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
      if (taskRes.ok && taskRes.data && taskRes.data[0]) {
        var caseId = taskRes.data[0].case_id;
        var sppaTaskRes = await supabaseDbRequest('registration_tasks',
          'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.sppa_00&limit=1');
        var sppaTaskId = (sppaTaskRes.ok && sppaTaskRes.data && sppaTaskRes.data[0]) ? sppaTaskRes.data[0].id : null;
        if (sppaTaskId) {
          docRes = await supabaseDbRequest('task_documents',
            'select=attachment_url&task_id=eq.' + encodeURIComponent(sppaTaskId) + '&is_current=eq.true&category=neq.alt_supervisor_cv&limit=1');
          doc = (docRes.ok && docRes.data && docRes.data[0]) ? docRes.data[0] : null;
        }
      }
    }

    if (!doc || !doc.attachment_url) { sendJson(res, 404, { error: 'No SPPA PDF found' }); return; }

    const commaIdx = doc.attachment_url.indexOf(',');
    var b64 = doc.attachment_url.substring(commaIdx + 1).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const pdfBuffer = Buffer.from(b64, 'base64');

    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="SPPA-00.pdf"' });
    res.end(pdfBuffer);
    return;
  }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "fix: /sppa-pdf endpoint resolves AHPRA amendment task IDs via case_id fallback"
```

---

### Task 2: Create `pages/pdf-editor.html`

**Files:**
- Create: `pages/pdf-editor.html`

This is the standalone PDF.js editor page. It fetches the SPPA PDF, renders pages to canvas, overlays editable HTML form inputs using annotation data, and communicates results to the parent window via `postMessage`.

**Key design decisions:**
- PDF.js loaded from cdnjs CDN (core + worker only — no `pdf_viewer.mjs` dependency)
- Form fields positioned manually from `page.getAnnotations()` data (simpler, more controllable than `AnnotationLayer` import chain)
- IntersectionObserver for lazy page rendering (13-page PDF)
- Multiline text fields use `<textarea>`, single-line use `<input>`
- Signature fields render as read-only placeholders
- Zoom re-renders visible pages at the new scale

- [ ] **Step 1: Create the complete `pages/pdf-editor.html` file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edit SPPA-00</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#64748b; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; overflow-y:auto; }

#toolbar {
  position:sticky; top:0; z-index:100;
  display:flex; align-items:center; justify-content:space-between;
  padding:10px 16px; background:#1e293b; color:#fff;
  box-shadow:0 2px 8px rgba(0,0,0,.3);
}
.toolbar-section { display:flex; align-items:center; gap:8px; }
.toolbar-section button {
  padding:6px 14px; border-radius:6px; border:none; cursor:pointer;
  font-size:13px; font-weight:600; font-family:inherit;
}
#cancelBtn { background:#475569; color:#fff; }
#cancelBtn:hover { background:#64748b; }
#saveBtn { background:#22c55e; color:#fff; }
#saveBtn:hover { background:#16a34a; }
#saveBtn:disabled { background:#6b7280; cursor:not-allowed; }
.zoom-btn { background:#334155; color:#fff; width:32px; height:32px; padding:0; font-size:16px; line-height:1; }
.zoom-btn:hover { background:#475569; }
#zoomLevel, #pageInfo { font-size:12px; color:#94a3b8; }

#viewer {
  padding:20px; display:flex; flex-direction:column; align-items:center; gap:16px;
  min-height:calc(100vh - 52px);
}
.page-container {
  position:relative; background:#fff; box-shadow:0 2px 10px rgba(0,0,0,.3);
}
.page-container canvas { display:block; }
.annotation-overlay { position:absolute; inset:0; }

.pdf-field { position:absolute; box-sizing:border-box; }
.pdf-text-field {
  background:rgba(255,255,200,0.25); border:1px solid transparent;
  font-size:10px; padding:1px 3px; font-family:Arial,Helvetica,sans-serif;
  color:#1e293b; line-height:1.2;
}
.pdf-text-field:hover { background:rgba(255,255,200,0.5); border-color:#93c5fd; }
.pdf-text-field:focus { background:rgba(255,255,200,0.7); border-color:#3b82f6; outline:none; z-index:10; }
textarea.pdf-text-field { resize:none; overflow:hidden; }
.pdf-checkbox-field, .pdf-radio-field {
  cursor:pointer; opacity:0.6; accent-color:#3b82f6;
}
.pdf-checkbox-field:hover, .pdf-radio-field:hover { opacity:1; }
.pdf-signature-field {
  background:rgba(200,200,200,0.2); border:1px dashed #94a3b8;
  display:flex; align-items:center; justify-content:center;
  font-size:9px; color:#94a3b8; pointer-events:none;
}

#loading {
  position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
  background:rgba(0,0,0,.6); color:#fff; font-size:15px; z-index:200;
}
#loading.hidden { display:none; }
#errorMsg {
  position:fixed; inset:0; display:none; align-items:center; justify-content:center;
  background:rgba(0,0,0,.7); color:#fff; font-size:15px; z-index:200; flex-direction:column; gap:12px;
}
#errorMsg.visible { display:flex; }
</style>
</head>
<body>
<div id="toolbar">
  <div class="toolbar-section">
    <span id="pageInfo">Loading...</span>
  </div>
  <div class="toolbar-section">
    <button class="zoom-btn" id="zoomOut" title="Zoom out">&minus;</button>
    <span id="zoomLevel">150%</span>
    <button class="zoom-btn" id="zoomIn" title="Zoom in">+</button>
  </div>
  <div class="toolbar-section">
    <button id="cancelBtn">Cancel</button>
    <button id="saveBtn">Save &amp; Close</button>
  </div>
</div>
<div id="viewer"></div>
<div id="loading">Loading SPPA-00...</div>
<div id="errorMsg"><span id="errorText"></span><button onclick="window.parent.postMessage({type:'sppa-editor-cancel'},'*')" style="padding:8px 16px;border-radius:6px;border:none;background:#475569;color:#fff;cursor:pointer">Close</button></div>

<script type="module">
  var PDFJS_VERSION = '4.4.168';
  var CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VERSION;

  var pdfjsLib;
  try {
    pdfjsLib = await import(CDN + '/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + '/pdf.worker.min.mjs';
  } catch (err) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('errorText').textContent = 'Failed to load PDF.js: ' + err.message;
    document.getElementById('errorMsg').classList.add('visible');
    throw err;
  }

  var taskId = new URLSearchParams(location.search).get('taskId');
  if (!taskId) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('errorText').textContent = 'No taskId provided';
    document.getElementById('errorMsg').classList.add('visible');
    throw new Error('No taskId');
  }

  var currentScale = 1.5;
  var pdf = null;
  var renderedPages = {};
  var viewer = document.getElementById('viewer');

  // ── Fetch and load PDF ──
  try {
    var resp = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-pdf', { credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var arrayBuf = await resp.arrayBuffer();
    pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  } catch (err) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('errorText').textContent = 'Failed to load PDF: ' + err.message;
    document.getElementById('errorMsg').classList.add('visible');
    throw err;
  }

  document.getElementById('pageInfo').textContent = pdf.numPages + ' pages';
  document.getElementById('loading').classList.add('hidden');

  // ── Create page placeholders ──
  for (var i = 1; i <= pdf.numPages; i++) {
    var page = await pdf.getPage(i);
    var vp = page.getViewport({ scale: currentScale });
    var container = document.createElement('div');
    container.className = 'page-container';
    container.dataset.pageNum = i;
    container.style.width = vp.width + 'px';
    container.style.height = vp.height + 'px';
    viewer.appendChild(container);
  }

  // ── Lazy rendering via IntersectionObserver ──
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        renderPage(parseInt(entry.target.dataset.pageNum));
      }
    });
  }, { rootMargin: '300px' });

  document.querySelectorAll('.page-container').forEach(function (el) { observer.observe(el); });

  async function renderPage(num) {
    var container = document.querySelector('.page-container[data-page-num="' + num + '"]');
    if (!container || renderedPages[num]) return;
    renderedPages[num] = true;

    var page = await pdf.getPage(num);
    var viewport = page.getViewport({ scale: currentScale });

    // Canvas
    var canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    var ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    container.appendChild(canvas);

    // Annotation overlay
    var annotations = await page.getAnnotations();
    var overlay = document.createElement('div');
    overlay.className = 'annotation-overlay';

    annotations.forEach(function (annot) {
      if (annot.subtype !== 'Widget') return;
      var rect = annot.rect;
      // Convert PDF coords (bottom-left origin) to viewport coords (top-left origin)
      var p1 = viewport.convertToViewportPoint(rect[0], rect[1]);
      var p2 = viewport.convertToViewportPoint(rect[2], rect[3]);
      var left = Math.min(p1[0], p2[0]);
      var top = Math.min(p1[1], p2[1]);
      var width = Math.abs(p2[0] - p1[0]);
      var height = Math.abs(p2[1] - p1[1]);

      var el;
      if (annot.fieldType === 'Tx') {
        if (annot.multiLine) {
          el = document.createElement('textarea');
          el.className = 'pdf-field pdf-text-field';
        } else {
          el = document.createElement('input');
          el.type = 'text';
          el.className = 'pdf-field pdf-text-field';
        }
        el.value = annot.fieldValue || '';
        el.dataset.fieldName = annot.fieldName || '';
        el.dataset.originalValue = annot.fieldValue || '';
        el.title = annot.fieldName || '';
      } else if (annot.fieldType === 'Btn' && annot.checkBox) {
        el = document.createElement('input');
        el.type = 'checkbox';
        el.checked = !!(annot.fieldValue && annot.fieldValue !== 'Off');
        el.dataset.fieldName = annot.fieldName || '';
        el.dataset.originalValue = annot.fieldValue || 'Off';
        el.className = 'pdf-field pdf-checkbox-field';
        el.title = annot.fieldName || '';
      } else if (annot.fieldType === 'Btn' && annot.radioButton) {
        el = document.createElement('input');
        el.type = 'radio';
        el.name = 'radio_' + (annot.fieldName || annot.id);
        el.value = annot.buttonValue || '';
        el.checked = annot.fieldValue === annot.buttonValue;
        el.dataset.fieldName = annot.fieldName || '';
        el.dataset.buttonValue = annot.buttonValue || '';
        el.dataset.originalValue = annot.fieldValue || '';
        el.className = 'pdf-field pdf-radio-field';
        el.title = (annot.fieldName || '') + ': ' + (annot.buttonValue || '');
      } else if (annot.fieldType === 'Sig') {
        el = document.createElement('div');
        el.className = 'pdf-field pdf-signature-field';
        el.textContent = '[Signature]';
        el.title = annot.fieldName || 'Signature';
      } else {
        return;
      }

      el.style.position = 'absolute';
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.width = width + 'px';
      el.style.height = height + 'px';
      overlay.appendChild(el);
    });

    container.appendChild(overlay);
  }

  // ── Zoom controls ──
  var SCALES = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
  function setZoom(newScale) {
    currentScale = newScale;
    document.getElementById('zoomLevel').textContent = Math.round(newScale * 100) + '%';
    // Clear rendered pages and re-render visible ones
    renderedPages = {};
    document.querySelectorAll('.page-container').forEach(function (c) {
      var num = parseInt(c.dataset.pageNum);
      c.innerHTML = '';
      pdf.getPage(num).then(function (page) {
        var vp = page.getViewport({ scale: currentScale });
        c.style.width = vp.width + 'px';
        c.style.height = vp.height + 'px';
      });
    });
    // Re-observe triggers rendering of visible pages
    observer.disconnect();
    document.querySelectorAll('.page-container').forEach(function (el) { observer.observe(el); });
  }

  document.getElementById('zoomIn').onclick = function () {
    var idx = SCALES.indexOf(currentScale);
    if (idx < 0) idx = SCALES.findIndex(function (s) { return s > currentScale; }) - 1;
    if (idx < SCALES.length - 1) setZoom(SCALES[idx + 1]);
  };
  document.getElementById('zoomOut').onclick = function () {
    var idx = SCALES.indexOf(currentScale);
    if (idx < 0) idx = SCALES.findIndex(function (s) { return s >= currentScale; });
    if (idx > 0) setZoom(SCALES[idx - 1]);
  };

  // ── Extract changed fields ──
  function extractChangedFields() {
    var fields = [];
    var seen = {};
    document.querySelectorAll('.pdf-text-field').forEach(function (el) {
      var name = el.dataset.fieldName;
      if (!name) return;
      var val = (el.value || '').trim();
      var orig = (el.dataset.originalValue || '').trim();
      if (val !== orig) fields.push({ name: name, value: val });
    });
    document.querySelectorAll('.pdf-checkbox-field').forEach(function (el) {
      var name = el.dataset.fieldName;
      if (!name) return;
      var val = el.checked ? 'Yes' : 'Off';
      if (val !== (el.dataset.originalValue || 'Off')) fields.push({ name: name, value: val });
    });
    document.querySelectorAll('.pdf-radio-field:checked').forEach(function (el) {
      var name = el.dataset.fieldName;
      if (!name || seen[name]) return;
      seen[name] = true;
      if (el.value !== (el.dataset.originalValue || '')) fields.push({ name: name, value: el.value });
    });
    return fields;
  }

  // ── Save & Cancel ──
  document.getElementById('saveBtn').onclick = function () {
    var fields = extractChangedFields();
    window.parent.postMessage({ type: 'sppa-fields-saved', fields: fields }, '*');
  };

  document.getElementById('cancelBtn').onclick = function () {
    window.parent.postMessage({ type: 'sppa-editor-cancel' }, '*');
  };
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the page loads**

Open `/pages/pdf-editor?taskId=<valid_task_id>` directly in the browser (while logged in as admin). Verify:
- PDF.js loads from CDN without console errors
- PDF pages render with form fields overlaid
- Text fields are editable, checkboxes are clickable
- Zoom buttons work

- [ ] **Step 3: Commit**

```bash
git add pages/pdf-editor.html
git commit -m "feat: PDF.js inline SPPA editor page with form field overlays"
```

---

### Task 3: Update admin.html — replace inline editor with modal

**Files:**
- Modify: `pages/admin.html:770` (CSS), `pages/admin.html:1335` (HTML), `pages/admin.html:4889-4909` (render function), `pages/admin.html:8182-8239` (JS functions)

Replace the raw field-name editor with a button that opens a full-screen modal containing the PDF editor iframe. Handle `postMessage` from the editor to save fields and close the modal.

- [ ] **Step 1: Add modal CSS**

In `pages/admin.html`, after the `.sppa-review-footer` CSS rule (around line 777), add:

```css
.pdf-editor-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:140;display:none;place-items:center}
.pdf-editor-overlay.open{display:grid}
.pdf-editor-panel{background:#fff;border-radius:16px;width:95vw;height:95vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden}
.pdf-editor-panel iframe{flex:1;border:none;width:100%;height:100%}
```

- [ ] **Step 2: Add modal HTML**

In `pages/admin.html`, after the closing `</div>` of `sppaReviewOverlay` (after line 1335), add:

```html
  <!-- PDF Editor Modal -->
  <div class="pdf-editor-overlay" id="pdfEditorOverlay">
    <div class="pdf-editor-panel">
      <iframe id="pdfEditorIframe" src="about:blank"></iframe>
    </div>
  </div>
```

- [ ] **Step 3: Replace inline field editor with "Edit SPPA-00" button**

In `pages/admin.html`, find the RSO amendment section (around lines 4895-4909). Replace:

```javascript
        // Inline SPPA field editor — loads form fields from server
        h3 += '<div id="sppaFieldEditor_' + esc(task.id) + '" style="margin:10px 0">';
        h3 += '<div style="font-weight:700;font-size:12px;margin-bottom:6px">Edit SPPA-00 Fields</div>';
        h3 += '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">Loading form fields...</div>';
        h3 += '</div>';
        h3 += '<script>loadSppaFieldEditor("' + escAttr(task.id) + '")<\/script>';
```

With:

```javascript
        // Open PDF editor modal button
        h3 += '<div style="margin:10px 0">';
        h3 += '<button class="ops-btn-secondary" onclick="openPdfEditor(\'' + escAttr(task.id) + '\')">Edit SPPA-00</button>';
        h3 += '</div>';
```

Also remove the old save-and-send wrapper button (the reply composer already has its own "Send to AHPRA" button via `_ahpraReplyComposerHtml`):

```javascript
        h3 += '<div class="ops-action-row" style="margin-top:8px">';
        h3 += '<button class="ops-btn-green" onclick="saveSppaFieldsAndSend(\'' + escAttr(task.id) + '\')">Save Changes &amp; Send to AHPRA</button>';
        h3 += '</div>';
```

Delete these 3 lines entirely — the reply composer (line 4902) already generates a "Send to AHPRA" button with `data-ops-send-ahpra-email`.

- [ ] **Step 4: Remove old `loadSppaFieldEditor` and `saveSppaFieldsAndSend` functions**

Delete lines 8182-8239 (the two functions and their window assignments):

```javascript
  async function loadSppaFieldEditor(taskId) { ... }
  window.loadSppaFieldEditor = loadSppaFieldEditor;

  async function saveSppaFieldsAndSend(taskId) { ... }
  window.saveSppaFieldsAndSend = saveSppaFieldsAndSend;
```

- [ ] **Step 5: Add new PDF editor modal functions and message handler**

Insert the following before the closing `})();` of the admin IIFE (around line 8240, after removing the old functions):

```javascript
  // ── PDF Editor Modal ──
  var _pdfEditorTaskId = null;

  function openPdfEditor(taskId) {
    _pdfEditorTaskId = taskId;
    var iframe = document.getElementById('pdfEditorIframe');
    iframe.src = '/pages/pdf-editor?taskId=' + encodeURIComponent(taskId);
    document.getElementById('pdfEditorOverlay').classList.add('open');
  }

  function closePdfEditor() {
    _pdfEditorTaskId = null;
    document.getElementById('pdfEditorOverlay').classList.remove('open');
    document.getElementById('pdfEditorIframe').src = 'about:blank';
  }

  window.addEventListener('message', async function (evt) {
    if (!_pdfEditorTaskId) return;
    var taskId = _pdfEditorTaskId;

    if (evt.data && evt.data.type === 'sppa-editor-cancel') {
      closePdfEditor();
      return;
    }

    if (evt.data && evt.data.type === 'sppa-fields-saved') {
      var fields = evt.data.fields || [];
      if (fields.length === 0) {
        closePdfEditor();
        toast('No changes made');
        return;
      }
      try {
        toast('Saving ' + fields.length + ' field change(s)...');
        var r = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-save-fields', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: fields })
        });
        var d = await r.json().catch(function () { return {}; });
        if (!d.ok) { toast('Save failed: ' + (d.error || ''), 'red'); return; }
        toast(d.amended + ' field(s) updated on SPPA-00');
        closePdfEditor();
        await loadAll(true);
      } catch (err) {
        toast('Error saving: ' + err.message, 'red');
      }
    }
  });

  window.openPdfEditor = openPdfEditor;
  window.closePdfEditor = closePdfEditor;
```

- [ ] **Step 6: Add Escape key and backdrop click to close the PDF editor modal**

In the existing keydown handler (around line 5818), add a check for the PDF editor overlay before the SPPA review overlay check:

```javascript
if(document.getElementById("pdfEditorOverlay").classList.contains("open")){closePdfEditor();return;}
```

After the sppaReviewOverlay backdrop click handler (around line 5860), add:

```javascript
document.getElementById("pdfEditorOverlay").addEventListener("click",function(e){if(e.target===document.getElementById("pdfEditorOverlay"))closePdfEditor();});
```

- [ ] **Step 7: Verify end-to-end**

1. Open admin dashboard → navigate to an RSO amendment task
2. Verify "Edit SPPA-00" button appears (not the old field-name editor)
3. Click "Edit SPPA-00" → full-screen modal opens with PDF rendered
4. Edit a text field, click "Save & Close" → toast shows "N field(s) updated"
5. Modal closes, task view refreshes
6. Re-open editor → verify the change persisted
7. Click "Send to AHPRA" → verify the email composer sends correctly
8. Test Cancel button, Escape key, and backdrop click all close the modal

- [ ] **Step 8: Commit**

```bash
git add pages/admin.html
git commit -m "feat: replace inline SPPA field editor with PDF.js visual editor modal"
```

---

### Task 4: Push to remote

- [ ] **Step 1: Push all commits**

```bash
git push origin main
```
