# Auto-Deliver Offer/Contract from Zoho Recruit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a GP is marked as hired in Zoho Recruit, automatically fetch the contract PDF from Zoho and deliver it to their My Documents "Offer/contract" slot + Google Drive folder.

**Architecture:** A new `deliverOfferContract(userId, caseId, zohoAppId, zohoCandidateId)` helper reuses existing Zoho attachment resolution (`listZohoRecruitApplicationAttachments` → `selectZohoContractAttachmentCandidates`), downloads the PDF, and delivers via `deliverToMyDocuments` + state updates. Called from two trigger points: (A) the Zoho cron sync when hired status is detected, and (B) the practice pack automation at placement secured time (as fallback). Idempotent — skips if already delivered.

**Tech Stack:** Node.js (server.js), Zoho Recruit Attachments API, Supabase (user_documents, practice_doc_ops, user_state), Google Drive API

---

### Task 1: Create the `deliverOfferContract` helper function

**Files:**
- Modify: `server.js` — insert after `_updatePreparedDocsState` (around line 420)

- [ ] **Step 1: Add the helper function**

Insert after the `_updatePreparedDocsState` function (before the `// ── Gmail integration` comment):

```javascript
// Fetch the offer/contract PDF from Zoho Recruit and deliver to My Documents + Drive
async function deliverOfferContract(userId, caseId, zohoApplicationId, zohoCandidateId) {
  if (!userId || !caseId) return null;
  // Idempotent: skip if already delivered
  var existingDoc = await supabaseDbRequest('user_documents',
    'select=id&user_id=eq.' + encodeURIComponent(userId) + '&document_key=eq.offer_contract&status=in.(approved,uploaded,received)&limit=1');
  if (existingDoc.ok && Array.isArray(existingDoc.data) && existingDoc.data.length > 0) {
    console.log('[OfferContract] Already delivered for user', userId, '— skipping');
    return { skipped: true };
  }

  if (!isZohoRecruitConfigured()) { console.log('[OfferContract] Zoho Recruit not configured — skipping'); return null; }
  var zoho = await getZohoRecruitAccessTokenAndDomain();
  if (!zoho) { console.error('[OfferContract] Failed to get Zoho token'); return null; }

  // 1. Find contract attachment — try Application first, fall back to Candidate
  var attachments = [];
  if (zohoApplicationId) {
    attachments = await listZohoRecruitApplicationAttachments(zoho, zohoApplicationId);
  }
  var candidates = selectZohoContractAttachmentCandidates(attachments);

  if (candidates.length === 0 && zohoCandidateId) {
    console.log('[OfferContract] No contract on Application, trying Candidate record');
    attachments = await listZohoRecruitCandidateAttachments(zoho, zohoCandidateId);
    candidates = selectZohoContractAttachmentCandidates(attachments);
  }

  if (candidates.length === 0) {
    console.log('[OfferContract] No contract attachment found for user', userId);
    return null;
  }

  var best = candidates[0];
  var attachmentId = getZohoAttachmentId(best);
  var fileName = getZohoAttachmentFileName(best) || 'Offer Contract.pdf';

  // 2. Download the PDF
  var downloaded = zohoApplicationId
    ? await downloadZohoRecruitApplicationAttachment(zoho, zohoApplicationId, attachmentId)
    : await downloadZohoRecruitCandidateAttachment(zoho, zohoCandidateId, attachmentId);
  if (!downloaded || !downloaded.buffer) {
    console.error('[OfferContract] Failed to download attachment', attachmentId);
    return null;
  }

  // 3. Deliver to user_documents + Google Drive
  var delivery = await deliverToMyDocuments(userId, caseId, 'offer_contract', fileName, downloaded.buffer, downloaded.mimeType || 'application/pdf');
  console.log('[OfferContract] Delivered to user_documents + Drive for user', userId);

  // 4. Update gp_prepared_docs so My Documents shows "Ready"
  var driveFileId = delivery && delivery.driveFile ? delivery.driveFile : null;
  try { await _updatePreparedDocsState(userId, 'offer_contract', driveFileId, fileName); } catch (e) {
    console.error('[OfferContract] gp_prepared_docs update error:', e.message);
  }

  // 5. Mark practice_doc_ops as completed
  try {
    await _ensurePracticeDocOps(caseId);
    await supabaseDbRequest('practice_doc_ops', 'case_id=eq.' + encodeURIComponent(caseId) + '&document_key=eq.offer_contract', {
      method: 'PATCH', body: { ops_status: 'completed' }
    });
  } catch (e) {}

  // 6. Complete the registration task if one exists
  try {
    var ocTask = await supabaseDbRequest('registration_tasks',
      'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.offer_contract&status=in.(open,in_progress,waiting,deferred)&limit=1');
    if (ocTask.ok && Array.isArray(ocTask.data) && ocTask.data[0]) {
      await _completeRegTask(ocTask.data[0].id, caseId, 'system');
    }
  } catch (e) {}

  await _logCaseEvent(caseId, null, 'system', 'Offer/contract auto-delivered from Zoho Recruit: ' + fileName, null, 'system');
  return { delivered: true, fileName: fileName, driveFileId: driveFileId };
}
```

- [ ] **Step 2: Verify the function is syntactically valid**

Run: `node -c server.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add deliverOfferContract helper for Zoho contract auto-delivery"
```

---

### Task 2: Fix the broken practice pack contract check and wire up Trigger B

**Files:**
- Modify: `server.js:6544-6572` — replace the existing broken contract check

The existing code at line 6544-6572 has two bugs:
1. `listZohoRecruitApplicationAttachments(_appId)` is called without the `zoho` token object (wrong arg order)
2. It only tags the task with `zoho_attachment_id` but never downloads or delivers the PDF

Replace the entire block with a call to the new `deliverOfferContract` helper.

- [ ] **Step 1: Replace the broken contract check block**

Find the block starting at line 6544:
```javascript
      // Check Zoho Recruit for existing contract attachment
      try {
        const _careerStateForOC = _parseStateVal(nxt.gp_career_state);
        const _appsForOC = Array.isArray(_careerStateForOC.applications) ? _careerStateForOC.applications : [];
        const _securedApp = _appsForOC.find(function (a) { return a && a.isPlacementSecured === true; });
        const _appId = _securedApp ? (_securedApp.zohoApplicationId || _securedApp.applicationId || _securedApp.id) : null;
        if (_appId && typeof listZohoRecruitApplicationAttachments === 'function') {
          const _attachments = await listZohoRecruitApplicationAttachments(_appId);
```

Replace the entire `// Check Zoho Recruit for existing contract attachment` try/catch block (lines 6544-6572) with:

```javascript
      // Auto-deliver offer/contract from Zoho Recruit
      try {
        const _careerStateForOC = _parseStateVal(nxt.gp_career_state);
        const _appsForOC = Array.isArray(_careerStateForOC.applications) ? _careerStateForOC.applications : [];
        const _securedApp = _appsForOC.find(function (a) { return a && a.isPlacementSecured === true; });
        const _ocAppId = _securedApp ? (_securedApp.zohoApplicationId || _securedApp.applicationId || '') : '';
        const _ocCandId = _securedApp ? (_securedApp.zohoCandidateId || '') : '';
        if (_ocAppId || _ocCandId) {
          await deliverOfferContract(userId, caseId, _ocAppId, _ocCandId);
        }
      } catch (ocErr) {
        console.error('[PracticePack] Offer/Contract auto-delivery error:', ocErr.message);
      }
```

- [ ] **Step 2: Verify syntax**

Run: `node -c server.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "fix: replace broken practice pack contract check with deliverOfferContract"
```

---

### Task 3: Wire up Trigger A — Zoho cron sync on hired status

**Files:**
- Modify: `server.js:11460-11465` — add contract delivery after task automation fires

In the cron sync function `syncZohoRecruitApplicationStatuses`, after the placement is secured and `processRegistrationTaskAutomation` is called (line 11462), add a call to `deliverOfferContract`. The cron context has `app.user_id`, `app.zoho_application_id`, and can resolve `caseId` via `_ensureRegCase`.

- [ ] **Step 1: Add contract delivery after task automation**

Find this block (around line 11460):
```javascript
          // Fire task automation so Practice Pack (Drive folder, Section G, tasks, SPPA-00) is created
          const gpEmail = profile.email || '';
          processRegistrationTaskAutomation(app.user_id, gpEmail, prevState, currentState).catch(function (err) {
            console.error('[ZohoRecruit sync] Task automation failed for user', app.user_id, ':', err && err.message);
          });
```

Add immediately AFTER it (before the closing `}`):

```javascript

          // Auto-deliver offer/contract from Zoho attachment
          (async function () {
            try {
              var ocCase = await _ensureRegCase(app.user_id);
              var ocCaseId = ocCase ? ocCase.id : null;
              if (ocCaseId) {
                await deliverOfferContract(app.user_id, ocCaseId, app.zoho_application_id || '', app.zoho_candidate_id || '');
              }
            } catch (ocErr) {
              console.error('[ZohoRecruit sync] Offer/contract delivery failed for user', app.user_id, ':', ocErr.message);
            }
          })();
```

- [ ] **Step 2: Also deliver when hired status detected on EXISTING secured placements**

The above code only runs inside the `if (nowSecured && !wasSecured)` block (first-time hire). We also need to deliver for users who were already secured but the contract was uploaded to Zoho later.

Find the status update patch write (around line 11468):
```javascript
      // Write the status update
      await supabaseDbRequest('gp_applications', 'id=eq.' + encodeURIComponent(app.id), {
```

Add BEFORE it:

```javascript
      // Attempt contract delivery for any secured application (catches late Zoho uploads)
      if (nowSecured) {
        (async function () {
          try {
            var ocCase = await _ensureRegCase(app.user_id);
            if (ocCase) await deliverOfferContract(app.user_id, ocCase.id, app.zoho_application_id || '', app.zoho_candidate_id || '');
          } catch (e) {
            console.error('[ZohoRecruit sync] Late contract delivery error:', e.message);
          }
        })();
      }

```

- [ ] **Step 3: Verify syntax**

Run: `node -c server.js`
Expected: No syntax errors

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: wire up offer/contract auto-delivery in Zoho cron sync"
```

---

### Task 4: Verify `zoho_candidate_id` is available on gp_applications

**Files:**
- Modify: `server.js` — check column availability in cron sync query

- [ ] **Step 1: Check if the cron sync selects `zoho_candidate_id`**

Search the cron sync query (around line 11351) for what columns it selects from `gp_applications`. If `zoho_candidate_id` is not in the select list, add it.

Grep for the select query:
```bash
grep -n 'gp_applications.*select=' server.js | head -10
```

If `zoho_candidate_id` is not selected, add it to the query. The `deliverOfferContract` helper falls back to candidate attachments when application attachments are empty, so having `zoho_candidate_id` is important for that fallback path.

- [ ] **Step 2: Commit if changed**

```bash
git add server.js
git commit -m "fix: ensure zoho_candidate_id is selected in cron sync query"
```

---

### Task 5: Deploy and test end-to-end

**Files:**
- No code changes

- [ ] **Step 1: Run syntax check**

Run: `node -c server.js`
Expected: No syntax errors

- [ ] **Step 2: Run test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit all changes and push**

```bash
git push
```

- [ ] **Step 4: Deploy to production**

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 /usr/local/Cellar/node@18/18.20.8/bin/npx vercel --prod --yes
```

- [ ] **Step 5: Test with Smith Miller's account**

From the admin console on `ceo.admin.mygplink.com.au`, find Smith Miller's Zoho application ID and trigger a manual test:

1. Check that the Zoho cron runs (it runs daily) or wait for the next cycle
2. Alternatively, call the redeliver endpoint pattern from the browser console to verify the helper works:

```javascript
// Verify the /api/gplink-docs-status endpoint returns offer_contract as ready after delivery
fetch('/api/gplink-docs-status', { credentials: 'same-origin' })
  .then(r => r.json()).then(console.log)
```

3. Check the admin Documents tab — "Offer/contract" should show as "COMPLETED" with a file
4. Check the user's My Documents page — "Offer/contract" should show as "Ready" with a download button
