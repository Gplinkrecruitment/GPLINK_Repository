# CEO Phase 3c — Document controls (upload / approve / request-revision)

> Implement→review→fix. HARD CONSTRAINT: do NOT modify `pages/admin.html`. All UI in `pages/ceo-dashboard.html` (dark). REUSE the existing `/api/admin/va/task/*` action endpoints unchanged. SAFETY: do NOT execute any live mutation during build/verify — wire the calls and verify by `node --check` + inline-compile + unit tests + code-tracing only. After each task `git diff --stat -- pages/admin.html` must be EMPTY.

**Goal:** Make the GP-file **Documents** sub-tab actionable. For GP LINK pack documents (`offer_contract`, `supervisor_cv`) the CEO can **Upload** a file, **Approve & Send to GP**, and **Request Revision** — exactly mirroring admin.html's gating — without any new server endpoint.

**Key facts (verified):**
- The CEO page already caches the case's full task rows in `gpDetailCache.tasks` (from `GET /api/admin/case?id=`, `select=*`). Each task carries `id`, `related_document_key`, `attachment_url`, `attachment_filename`, `zoho_attachment_id`, `gmail_message_id`, `task_type`, `status`.
- A document row maps to its task by `task.related_document_key === doc.key` AND `task.task_type === 'practice_pack_child'`.
- admin.html gating (pages/admin.html ~1725): **Approve** shows when `task.zoho_attachment_id || task.attachment_url`; **Request Revision** shows when `task.gmail_message_id && task.attachment_url`; **Upload** is offered for tasks whose `related_document_key` is `offer_contract`/`supervisor_cv`.
- Action endpoints (all `requireAdminSession`; a super-admin passes — DO NOT modify them):
  - `POST /api/admin/va/task/upload-document` — JSON `{task_id, file_data, file_name}` where `file_data` is a base64 data URL (`FileReader.readAsDataURL`). Only `related_document_key` in `['offer_contract','supervisor_cv']`. Returns `{ok, message}`.
  - `POST /api/admin/va/task/approve-document` — JSON `{task_id}`. Returns `{ok, delivery}`.
  - `POST /api/admin/va/task/request-revision` — JSON `{task_id}`. Returns `{ok, draft_url}` (open `draft_url` in a new tab).
- `gpDocumentSections` exists in BOTH `lib/ceo-metrics.js` (line ~388, unit-tested) and inline in `pages/ceo-dashboard.html` (line ~2580). They are kept in sync. It currently drops the document `key` — we must preserve it.
- The CEO page already has `refreshGpDetailTasks()` (re-fetches `/api/admin/case`, updates `gpDetailCache`, re-renders current sub-tab). Documents are cached in `gpDocumentsCache` and (re)loaded by `loadGpDocuments(caseId)` / `renderGpDocumentsTab()`.

**Files:** `lib/ceo-metrics.js`, `tests/ceo-metrics.test.js`, `pages/ceo-dashboard.html`.

---

### Task 3c.1: lib helpers `docTaskForKey` + `docActionsFor`, and preserve `key` in `gpDocumentSections`

**Files:** Modify `lib/ceo-metrics.js`; Modify `tests/ceo-metrics.test.js`.

- [ ] **Step 1 (test — gpDocumentSections key):** in the existing `describe('gpDocumentSections ...')` block in `tests/ceo-metrics.test.js`, add a test: given `documents = { preparedByGpLink: [{ key:'offer_contract', label:'Offer/contract', ops_status:'awaiting_practice' }] }`, assert the normalized doc carries `key === 'offer_contract'` (i.e. `M.gpDocumentSections(documents).find(s=>s.key==='preparedByGpLink').docs[0].key === 'offer_contract'`). Also assert a doc that only has `document_key` (no `key`) carries that value as `key`. Run `-t "gpDocumentSections"` → the key assertions FAIL.

- [ ] **Step 2 (impl — preserve key):** in `lib/ceo-metrics.js` `gpDocumentSections`, add `key: (d.key != null && d.key !== '') ? d.key : (d.document_key || '')` to the normalized doc object (keep all existing fields). Run the test → PASS.

- [ ] **Step 3 (test — docTaskForKey + docActionsFor):** append a new `describe('document action helpers')` block.
  - Fixture tasks:
    ```js
    const tasks = [
      { id:'t-old', task_type:'practice_pack_child', related_document_key:'offer_contract', status:'completed' },
      { id:'t1', task_type:'practice_pack_child', related_document_key:'offer_contract', status:'in_progress', attachment_url:'data:...', gmail_message_id:'g1' },
      { id:'t2', task_type:'practice_pack_child', related_document_key:'supervisor_cv', status:'open' },
      { id:'t3', task_type:'email_triage', related_document_key:'offer_contract', status:'open' }
    ];
    ```
  - `docTaskForKey(tasks,'offer_contract').id` === `'t1'` (skips completed `t-old`, ignores non-practice_pack_child `t3`).
  - `docTaskForKey(tasks,'supervisor_cv').id` === `'t2'`.
  - `docTaskForKey(tasks,'section_g')` === `null`. `docTaskForKey(tasks,'')` === `null`. `docTaskForKey(null,'offer_contract')` === `null`.
  - `docActionsFor(tasks[1])` (t1: offer_contract + attachment_url + gmail_message_id) === `{ upload:true, approve:true, requestRevision:true }`.
  - `docActionsFor(tasks[2])` (t2: supervisor_cv, no attachment) === `{ upload:true, approve:false, requestRevision:false }`.
  - `docActionsFor({ related_document_key:'section_g', attachment_url:'x' })` === `{ upload:false, approve:true, requestRevision:false }` (zoho/attachment present → approve; not uploadable key).
  - `docActionsFor(null)` === `{ upload:false, approve:false, requestRevision:false }`.
  Run `-t "document action helpers"` → FAIL (not defined).

- [ ] **Step 4 (impl):** add + export both helpers in `lib/ceo-metrics.js`:
  ```js
  // The actionable practice-pack task for a document key (most recent non-terminal
  // one), or null. Tasks arrive created_at.desc, so the first non-completed/cancelled
  // match is the newest open task. Used to attach document controls to GP LINK doc rows.
  function docTaskForKey(tasks, docKey) {
    if (!docKey) return null;
    var matches = [];
    for (var i = 0; i < (tasks || []).length; i++) {
      var t = tasks[i];
      if (t && t.task_type === 'practice_pack_child' && t.related_document_key === docKey) matches.push(t);
    }
    if (!matches.length) return null;
    for (var j = 0; j < matches.length; j++) {
      var s = matches[j].status;
      if (s !== 'completed' && s !== 'cancelled') return matches[j];
    }
    return matches[0];
  }

  // Which document actions are available for a task, mirroring admin.html gating
  // (pages/admin.html ~1725). Upload is offered for the two uploadable pack docs;
  // approve when an attachment is present; request-revision for auto-received docs.
  function docActionsFor(task) {
    var key = task && task.related_document_key;
    var canUpload = key === 'offer_contract' || key === 'supervisor_cv';
    var hasAttachment = !!(task && (task.attachment_url || task.zoho_attachment_id));
    var autoReceived = !!(task && task.gmail_message_id && task.attachment_url);
    return { upload: canUpload, approve: hasAttachment, requestRevision: autoReceived };
  }
  ```
  Add `docTaskForKey` and `docActionsFor` to `module.exports`. Run `-t "document action helpers"` → PASS.

- [ ] **Step 5:** `node --check lib/ceo-metrics.js`; `npx vitest run tests/ceo-metrics.test.js`; `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): docTaskForKey + docActionsFor helpers; preserve doc key in gpDocumentSections`.

---

### Task 3c.2: Mirror the helpers inline + render document action buttons (dark)

**Files:** Modify `pages/ceo-dashboard.html` (`gpDocumentSections` inline copy ~line 2580; `renderGpDocumentsPane` ~line 2600; add dark CSS).

- [ ] **Step 1:** in the INLINE `gpDocumentSections` (ceo-dashboard.html), add the same `key:` field to the normalized doc object so it matches the lib contract (`key: (d.key != null && d.key !== '') ? d.key : (d.document_key || '')`).

- [ ] **Step 2:** add inline copies of `docTaskForKey(tasks, docKey)` and `docActionsFor(task)` (identical logic to the lib helpers in 3c.1 Step 4) near the other GP-file helpers in ceo-dashboard.html.

- [ ] **Step 3:** in `renderGpDocumentsPane`, for each doc row, after the existing label/status/View markup, look up `var task = docTaskForKey((gpDetailCache && gpDetailCache.tasks) || [], doc.key);` and, if `task`, compute `var acts = docActionsFor(task);` and append a `.ceo-gp-doc-actions` container with buttons (dark, reusing `.btn`/`.btn-blue` and existing pill styles):
  - if `acts.upload`: a **Upload file** control — a `<label class="btn ceo-doc-upload-btn">Upload<input type="file" data-ceo-doc-upload="<task.id>" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.heic" style="display:none"></label>` (label wraps a hidden file input; clicking the label opens the picker).
  - if `acts.approve`: `<button class="btn btn-green" data-ceo-doc-action="approve" data-task="<task.id>">Approve &amp; Send to GP</button>`.
  - if `acts.requestRevision`: `<button class="btn" data-ceo-doc-action="revise" data-task="<task.id>">Request Revision</button>`.
  Escape all interpolated ids with `esc`. Do NOT render any action buttons for docs with no matching task (read-only as before).

- [ ] **Step 4:** add dark `.ceo-gp-doc-actions` CSS (flex row, gap, margin-top) and `.ceo-doc-upload-btn` styling reusing existing tokens so it matches `.ceo-gp-doc-row`. Buttons must be visually consistent with the dark theme.

- [ ] **Step 5:** inline `<script>` compiles (vm); `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): GP Documents — render upload/approve/request-revision controls`.

---

### Task 3c.3: Wire the document action handlers + refresh-after-action

**Files:** Modify `pages/ceo-dashboard.html` (add handlers + delegated listeners; add a documents refresh helper).

- [ ] **Step 1:** add `refreshGpDocuments()` — clears `gpDocumentsCache = null` and, if the open sub-tab is `documents`, calls `renderGpDocumentsTab()` (which re-fetches via `loadGpDocuments`). Add a combined `refreshGpDocsAndTasks()` that calls `refreshGpDetailTasks()` (refreshes `gpDetailCache.tasks`, needed because actions change task state) AND `refreshGpDocuments()`.

- [ ] **Step 2 (upload handler):** add `ceoDocUpload(taskId, inputEl)`:
  ```js
  function ceoDocUpload(taskId, inputEl) {
    var file = inputEl && inputEl.files && inputEl.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      apiFetch('/api/admin/va/task/upload-document', { method:'POST', body: JSON.stringify({ task_id: taskId, file_data: reader.result, file_name: file.name }) })
        .then(function (d) {
          if (!d || !d.ok) { toast((d && d.message) || 'Upload failed'); return; }
          toast('Document uploaded'); refreshGpDocsAndTasks();
        }).catch(function (e) { toast('Error: ' + e.message); });
    };
    reader.readAsDataURL(file);
  }
  ```
  (Use the page's existing `apiFetch` JSON helper and its `toast`/notification helper — grep for the exact names already used by the call/task handlers added in Phase 3b and reuse them; if `apiFetch` does not set `Content-Type`, match how the Phase 3b task actions POST JSON.)

- [ ] **Step 2b (approve + revise handlers):**
  ```js
  function ceoDocApprove(taskId) {
    if (!confirm('Approve this document and send it to the GP?')) return;
    apiFetch('/api/admin/va/task/approve-document', { method:'POST', body: JSON.stringify({ task_id: taskId }) })
      .then(function (d) { if (!d || !d.ok) { toast((d && d.message) || 'Approval failed'); return; } toast('Approved & sent'); refreshGpDocsAndTasks(); })
      .catch(function (e) { toast('Error: ' + e.message); });
  }
  function ceoDocRequestRevision(taskId) {
    if (!confirm('Create a revision-request draft in Gmail? The document is attached for the practice.')) return;
    apiFetch('/api/admin/va/task/request-revision', { method:'POST', body: JSON.stringify({ task_id: taskId }) })
      .then(function (d) { if (d && d.ok && d.draft_url) { window.open(d.draft_url, '_blank', 'noopener'); toast('Draft created — add your note and send'); refreshGpDocsAndTasks(); } else { toast('Error: ' + ((d && (d.message || d.error)) || 'Unknown error')); } })
      .catch(function (e) { toast('Error: ' + e.message); });
  }
  ```

- [ ] **Step 3 (delegated listeners):** wire delegation on the GP detail pane (reuse the existing pane click handler that already dispatches `data-gp-tab`/Phase 3b actions). Add: a `click` handler for `[data-ceo-doc-action]` → read `data-task` + the action (`approve`→`ceoDocApprove`, `revise`→`ceoDocRequestRevision`); and a `change` handler for `input[data-ceo-doc-upload]` → `ceoDocUpload(input.getAttribute('data-ceo-doc-upload'), input)`. Attach the `change` listener at a stable parent (delegation) so it survives `renderGpDocumentsPane` re-renders.

- [ ] **Step 4:** inline `<script>` compiles; confirm no `/api/admin/*` endpoint code changed and `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): GP Documents — wire upload/approve/request-revision actions + refresh`.

---

### Task 3c.4: Phase 3c verification gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages (extract `<script>` blocks without `src`, `vm.Script` each).
- [ ] **Step 3:** `npx vitest run` — full suite green.
- [ ] **Step 4 (HARD CONSTRAINT):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` must be EMPTY.
- [ ] **Step 5:** report totals + confirm the three actions are wired to the unchanged `/api/admin/va/task/*` endpoints; no commit.
