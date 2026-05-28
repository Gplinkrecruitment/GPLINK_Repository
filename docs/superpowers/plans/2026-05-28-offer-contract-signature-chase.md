# Offer/Contract Signature Chase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move offer/contract checking to onboarding completion so incomplete contracts (missing employer signature) are caught early and chased by admin.

**Architecture:** At onboarding complete, download the contract from Zoho, AI-scan for signatures. Single-signature → create task for admin with auto-attached contract email. Both signatures → auto-complete. On Zoho re-upload, re-scan and diff against previous version.

**Tech Stack:** Node.js, Anthropic Claude API (vision for PDF/image analysis), Supabase PostgreSQL, Gmail API

---

### Task 1: AI Signature Scan Function

**Files:**
- Modify: `server.js` — add after `deliverOfferContract()` (after line ~497)

- [ ] **Step 1: Add the `scanContractSignatures` function**

Insert after the closing brace of `deliverOfferContract()` (around line 497):

```javascript
/**
 * AI-scan a contract document for candidate and employer signatures.
 * Returns { has_candidate_signature, has_employer_signature, signature_count, confidence, notes }
 * On failure, defaults to { has_employer_signature: false } (safe default → task deployed to admin).
 */
async function scanContractSignatures(buffer, mimeType, filename) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[ContractScan] No ANTHROPIC_API_KEY configured');
    return { has_candidate_signature: false, has_employer_signature: false, signature_count: 0, confidence: 'none', notes: 'API key not configured' };
  }
  var mediaType = mimeType || 'application/pdf';
  // Normalize HEIC to JPEG for API compatibility
  if (/heic|heif/i.test(mediaType)) mediaType = 'image/jpeg';
  var contentBlocks = [];
  var isPdf = /pdf/i.test(mediaType);
  var isImage = /^image\//i.test(mediaType);
  var isDocx = /wordprocessingml|msword|\.docx?$/i.test(mediaType + (filename || ''));

  if (isPdf) {
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') }
    });
  } else if (isImage) {
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') }
    });
  } else if (isDocx) {
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: buffer.toString('base64') }
    });
  } else {
    // Unknown format — try sending as-is, let the model handle it
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') }
    });
  }

  contentBlocks.push({
    type: 'text',
    text: 'Analyze this employment contract document. Count the number of signatures present. For each signature found, identify whether it belongs to the candidate/employee or the employer/practice representative.\n\nReturn ONLY valid JSON in this exact format:\n{\n  "signature_count": <number>,\n  "has_candidate_signature": <boolean>,\n  "has_employer_signature": <boolean>,\n  "confidence": "<high|medium|low>",\n  "notes": "<brief explanation of what you found>"\n}\n\nLook for handwritten signatures, digital signatures, signature images, and typed signatures in signature blocks. An empty or blank signature line does NOT count as a signature.'
  });

  try {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 60000);
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        temperature: 0,
        messages: [{ role: 'user', content: contentBlocks }]
      })
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.error('[ContractScan] API error:', resp.status, await resp.text().catch(function () { return ''; }));
      return { has_candidate_signature: false, has_employer_signature: false, signature_count: 0, confidence: 'none', notes: 'API error: ' + resp.status };
    }
    var data = await resp.json();
    var text = data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';
    // Extract JSON from response (may be wrapped in markdown code blocks)
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[ContractScan] No JSON in response:', text.slice(0, 200));
      return { has_candidate_signature: false, has_employer_signature: false, signature_count: 0, confidence: 'none', notes: 'Could not parse AI response' };
    }
    var result = JSON.parse(jsonMatch[0]);
    console.log('[ContractScan] Result:', JSON.stringify(result));
    return {
      signature_count: result.signature_count || 0,
      has_candidate_signature: !!result.has_candidate_signature,
      has_employer_signature: !!result.has_employer_signature,
      confidence: result.confidence || 'low',
      notes: result.notes || ''
    };
  } catch (err) {
    console.error('[ContractScan] Error:', err.message);
    return { has_candidate_signature: false, has_employer_signature: false, signature_count: 0, confidence: 'none', notes: 'Scan error: ' + err.message };
  }
}
```

- [ ] **Step 2: Verify the function is syntactically valid**

Run: `cd "/Users/khaleed/GP LINK APP (Visual Studio)" && node -e "require('./server.js')" 2>&1 | head -5`

If the server starts listening, it parsed correctly. Kill it after.

- [ ] **Step 3: Commit**

```bash
git add server.js && git commit -m "feat: add AI contract signature scan function"
```

---

### Task 2: AI Contract Diff Function

**Files:**
- Modify: `server.js` — add immediately after `scanContractSignatures()` function

- [ ] **Step 1: Add the `diffContracts` function**

Insert right after `scanContractSignatures`:

```javascript
/**
 * Compare two versions of a contract and return a summary of differences.
 * Returns a string summary, or empty string on failure.
 */
async function diffContracts(oldBuffer, oldMime, newBuffer, newMime) {
  if (!process.env.ANTHROPIC_API_KEY) return '';
  var contentBlocks = [];
  function docBlock(buf, mime, label) {
    var isPdf = /pdf/i.test(mime);
    var isImage = /^image\//i.test(mime);
    if (isPdf) {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
    } else if (isImage) {
      return { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } };
    } else {
      var docMime = /wordprocessingml|\.docx/i.test(mime) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : mime;
      return { type: 'document', source: { type: 'base64', media_type: docMime, data: buf.toString('base64') } };
    }
  }

  contentBlocks.push({ type: 'text', text: 'PREVIOUS VERSION of the contract:' });
  contentBlocks.push(docBlock(oldBuffer, oldMime, 'previous'));
  contentBlocks.push({ type: 'text', text: 'NEW VERSION of the contract:' });
  contentBlocks.push(docBlock(newBuffer, newMime, 'new'));
  contentBlocks.push({
    type: 'text',
    text: 'Compare these two versions of the same employment contract. Identify ANY differences in terms, conditions, dates, salary, hours, location, role title, supervision arrangements, or other substantive changes. Be specific with before/after values. If the documents are identical except for signatures, say "No substantive changes — only signature additions." Return a concise plain-text summary (max 3-4 sentences).'
  });

  try {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 90000);
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        temperature: 0,
        messages: [{ role: 'user', content: contentBlocks }]
      })
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.error('[ContractDiff] API error:', resp.status);
      return '';
    }
    var data = await resp.json();
    var text = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '';
    console.log('[ContractDiff] Result:', text.slice(0, 300));
    return text;
  } catch (err) {
    console.error('[ContractDiff] Error:', err.message);
    return '';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server.js && git commit -m "feat: add AI contract diff function"
```

---

### Task 3: Onboarding Trigger — Check Contract on Onboarding Complete

**Files:**
- Modify: `server.js` — add background job in `/api/onboarding/complete` handler (after line ~22338) and a new orchestrator function near `deliverOfferContract`

- [ ] **Step 1: Add the `checkOfferContractAtOnboarding` orchestrator function**

Insert after the `diffContracts` function (so all contract-related functions are grouped):

```javascript
/**
 * Called at onboarding complete. Downloads contract from Zoho, AI-scans for signatures.
 * Both signatures → auto-complete. Single signature → create task for admin.
 */
async function checkOfferContractAtOnboarding(userId) {
  if (!isSupabaseDbConfigured()) return;
  try {
    // 1. Find the user's hired Zoho application
    var appRes = await supabaseDbRequest('gp_applications',
      'select=id,zoho_application_id,zoho_candidate_id,practice_contact_name,practice_contact_email&user_id=eq.' + encodeURIComponent(userId) + '&status=eq.hired&limit=1');
    var app = appRes.ok && Array.isArray(appRes.data) && appRes.data[0] ? appRes.data[0] : null;
    if (!app || !app.zoho_application_id) {
      console.log('[ContractCheck] No hired Zoho application for user', userId, '— skipping');
      return;
    }

    // 2. Get Zoho OAuth token
    var zoho = await getZohoRecruitOAuth();
    if (!zoho || !zoho.accessToken) {
      console.log('[ContractCheck] No Zoho OAuth token — skipping');
      return;
    }

    // 3. List and score contract attachments
    var attachments = await listZohoRecruitApplicationAttachments(
      { connection: zoho.connection, accessToken: zoho.accessToken, apiDomain: zoho.apiDomain },
      app.zoho_application_id
    );
    var candidates = selectZohoContractAttachmentCandidates(attachments);
    if (!candidates.length) {
      // Try candidate record as fallback
      if (app.zoho_candidate_id) {
        attachments = await listZohoRecruitApplicationAttachments(
          { connection: zoho.connection, accessToken: zoho.accessToken, apiDomain: zoho.apiDomain },
          app.zoho_candidate_id
        );
        candidates = selectZohoContractAttachmentCandidates(attachments);
      }
    }
    if (!candidates.length) {
      console.log('[ContractCheck] No contract attachment found in Zoho for user', userId);
      return;
    }

    var topCandidate = candidates[0];

    // 4. Download the contract
    var contractBuffer = null;
    try {
      contractBuffer = await downloadZohoRecruitApplicationAttachment(
        { connection: zoho.connection, accessToken: zoho.accessToken, apiDomain: zoho.apiDomain },
        app.zoho_application_id, topCandidate.id
      );
    } catch (dlErr) {
      // Fallback to candidate record
      if (app.zoho_candidate_id) {
        try {
          contractBuffer = await downloadZohoRecruitApplicationAttachment(
            { connection: zoho.connection, accessToken: zoho.accessToken, apiDomain: zoho.apiDomain },
            app.zoho_candidate_id, topCandidate.id
          );
        } catch (e) {}
      }
    }
    if (!contractBuffer || contractBuffer.length === 0) {
      console.error('[ContractCheck] Failed to download contract for user', userId);
      return;
    }

    var mimeType = topCandidate.mimeType || topCandidate.content_type || 'application/pdf';
    var filename = topCandidate.fileName || topCandidate.File_Name || 'contract.pdf';

    // 5. AI signature scan
    var scanResult = await scanContractSignatures(contractBuffer, mimeType, filename);
    console.log('[ContractCheck] Scan for user', userId, ':', JSON.stringify(scanResult));

    // 6. Ensure registration case exists
    var caseId = await _ensureRegCase(userId);
    if (!caseId) {
      console.error('[ContractCheck] Could not ensure reg case for user', userId);
      return;
    }

    // 7. Decision
    if (scanResult.has_candidate_signature && scanResult.has_employer_signature) {
      // Both signatures — auto-complete
      console.log('[ContractCheck] Both signatures found — auto-completing for user', userId);
      await deliverOfferContract(userId, caseId, app.zoho_application_id, app.zoho_candidate_id);
      await _logCaseEvent(caseId, null, 'note', 'Contract AI scan: both signatures detected — auto-completed', scanResult.notes || '', 'system');
      return;
    }

    // Single/zero signatures or scan failure — create task for admin
    console.log('[ContractCheck] Incomplete signatures — creating task for user', userId);

    // Check if an offer_contract task already exists for this case
    var existingTaskRes = await supabaseDbRequest('registration_tasks',
      'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.offer_contract&status=in.(open,in_progress,waiting,waiting_on_practice,waiting_on_external,escalated,deferred)&limit=1');
    if (existingTaskRes.ok && Array.isArray(existingTaskRes.data) && existingTaskRes.data.length > 0) {
      console.log('[ContractCheck] Offer/contract task already exists for case', caseId, '— skipping creation');
      return;
    }

    // Create the practice_pack_child task
    var dataUrl = 'data:' + mimeType + ';base64,' + contractBuffer.toString('base64');
    var task = await _createRegTask(caseId, {
      task_type: 'practice_pack_child',
      title: 'Offer / Contract',
      source_trigger: 'onboarding_signature_check',
      related_stage: 'career',
      related_document_key: 'offer_contract',
      status: 'open',
      zoho_attachment_id: topCandidate.id || null,
      attachment_url: dataUrl,
      attachment_filename: filename,
      _actor: 'system'
    });

    if (task) {
      // Store as task_documents record for the View button
      await supabaseDbRequest('task_documents', '', {
        method: 'POST',
        body: [{
          task_id: task.id,
          case_id: caseId,
          filename: filename,
          mime_type: mimeType,
          size_bytes: contractBuffer.length,
          version: 1,
          is_current: true,
          uploaded_by: 'zoho_import',
          attachment_url: dataUrl
        }]
      });

      // Log the scan result to timeline
      var scanNote = 'AI signature scan: ' + (scanResult.has_candidate_signature ? 'candidate signature found' : 'no candidate signature') +
        ', ' + (scanResult.has_employer_signature ? 'employer signature found' : 'employer signature missing') +
        (scanResult.notes ? ' — ' + scanResult.notes : '');
      await _logCaseEvent(caseId, task.id, 'note', scanNote, 'Confidence: ' + (scanResult.confidence || 'unknown'), 'system');
    }
  } catch (err) {
    console.error('[ContractCheck] Error for user', userId, ':', err.message);
  }
}
```

- [ ] **Step 2: Wire up the background job in `/api/onboarding/complete`**

Find the section near line 22325-22338 where the background Zoho candidate creation fires. Add the contract check AFTER the Zoho candidate creation (since we need the Zoho link to exist). Insert after the closing `})();` of the Zoho candidate creation block:

```javascript
    // Background: check offer contract signatures
    (async function () {
      try {
        await checkOfferContractAtOnboarding(userId);
      } catch (err) {
        console.error('[Onboarding] Contract signature check failed:', err.message);
      }
    })();
```

- [ ] **Step 3: Verify server starts**

Run: `cd "/Users/khaleed/GP LINK APP (Visual Studio)" && node -e "require('./server.js')" 2>&1 | head -5`

- [ ] **Step 4: Commit**

```bash
git add server.js && git commit -m "feat: check contract signatures at onboarding complete"
```

---

### Task 4: Guard in career_secured — Skip offer_contract If Already Exists

**Files:**
- Modify: `server.js` — in `processRegistrationTaskAutomation()` around line 6529-6536

- [ ] **Step 1: Add per-document-key guard**

The current code at line 6529-6536 creates all 5 practice pack tasks in a loop. Modify it to skip `offer_contract` if a task already exists for that document key:

Find this block (around line 6529):
```javascript
  if (!(await _hasOpenTask(caseId, 'career', 'practice_pack_child'))) {
    const packLabels = { sppa_00: 'SPPA-00', section_g: 'Section G', position_description: 'Position Description', offer_contract: 'Offer / Contract', supervisor_cv: 'Supervisor CV' };
    const deferredKeys = new Set(['sppa_00', 'section_g']);
    for (const dk of Object.keys(packLabels)) {
      const taskData = { task_type: 'practice_pack_child', title: packLabels[dk], source_trigger: 'career_secured', related_stage: 'career', related_document_key: dk, _actor: 'system' };
      if (deferredKeys.has(dk)) taskData.status = 'deferred';
      await _createRegTask(caseId, taskData);
    }
  }
```

Replace with:

```javascript
  if (!(await _hasOpenTask(caseId, 'career', 'practice_pack_child'))) {
    const packLabels = { sppa_00: 'SPPA-00', section_g: 'Section G', position_description: 'Position Description', offer_contract: 'Offer / Contract', supervisor_cv: 'Supervisor CV' };
    const deferredKeys = new Set(['sppa_00', 'section_g']);
    for (const dk of Object.keys(packLabels)) {
      // Skip if a task for this specific document key already exists (e.g. offer_contract from onboarding signature check)
      var existingForKey = await supabaseDbRequest('registration_tasks',
        'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.' + encodeURIComponent(dk) + '&status=in.(open,in_progress,waiting,waiting_on_practice,waiting_on_external,escalated,deferred,completed)&limit=1');
      if (existingForKey.ok && Array.isArray(existingForKey.data) && existingForKey.data.length > 0) continue;
      const taskData = { task_type: 'practice_pack_child', title: packLabels[dk], source_trigger: 'career_secured', related_stage: 'career', related_document_key: dk, _actor: 'system' };
      if (deferredKeys.has(dk)) taskData.status = 'deferred';
      await _createRegTask(caseId, taskData);
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add server.js && git commit -m "feat: skip practice pack task creation if task already exists for document key"
```

---

### Task 5: Admin Email Auto-Attach for Offer/Contract

**Files:**
- Modify: `pages/admin.html` — in `renderOpsPracticePackChild` State A email composer (around line 4186-4203) and the send email click handler (around line 5178-5204)

- [ ] **Step 1: Modify the email template for offer_contract tasks**

In `renderOpsPracticePackChild`, find the State A section (around line 4186). The current email composer is generic for all practice pack tasks. We need to customize it for `offer_contract` when it has an existing document (candidate-signed contract).

Find this block (around line 4186-4203):
```javascript
    // State A: No messages yet (initial, ball with Hazel) — show email composer
    var h3='<div class="ops-expand-section">';
    h3+='<div class="ops-expand-label">Request document from practice</div>';
    h3+='<div class="ops-email-composer">';
    h3+='<div class="ops-email-field"><span class="ops-email-label">To:</span><input data-email-to="'+esc(task.id)+'" value="'+esc(practiceEmail)+'" /></div>';
    h3+='<div class="ops-email-field"><span class="ops-email-label">Subject:</span><input data-email-subject="'+esc(task.id)+'" value="'+esc(docTitle)+' needed for Dr '+esc(gpName)+' - GP Link" /></div>';
    h3+='<div class="ops-email-body" contenteditable="true" data-email-body="'+esc(task.id)+'">'
      +'Hi '+esc(contactName||'')+',<br><br>'
      +'We are preparing the registration documents for Dr '+esc(gpName)+' and need the following: <strong>'+esc(docTitle)+'</strong>.<br><br>'
      +'Could you please send this through at your earliest convenience?<br><br>'
      +'Kind regards,<br>Hazel \u2014 GP Link Registration Team'
      +'</div>';
    h3+='<div class="ops-email-actions">';
    h3+='<button class="ops-btn-green" data-ops-send-email="'+esc(task.id)+'" data-ops-case="'+esc(task.case_id||'')+'" data-ops-flip-status="waiting_on_practice">Email Practice</button>';
    h3+='</div>';
    h3+='</div>';
    h3+='</div>';
    return h3;
```

Replace with:

```javascript
    // State A: No messages yet (initial, ball with Hazel) — show email composer
    var h3='<div class="ops-expand-section">';
    var isOfferContractWithDoc = (task.related_document_key === 'offer_contract') && (docs.length > 0 || task.attachment_url);
    h3+='<div class="ops-expand-label">'+(isOfferContractWithDoc ? 'Request employer counter-signature' : 'Request document from practice')+'</div>';
    if (isOfferContractWithDoc) {
      h3+=opsRenderDocs(docs);
      h3+='<div style="font-size:11px;color:var(--muted);margin:8px 0">The candidate-signed contract above will be automatically attached to the email.</div>';
    }
    h3+='<div class="ops-email-composer">';
    h3+='<div class="ops-email-field"><span class="ops-email-label">To:</span><input data-email-to="'+esc(task.id)+'" value="'+esc(practiceEmail)+'" /></div>';
    if (isOfferContractWithDoc) {
      h3+='<div class="ops-email-field"><span class="ops-email-label">Subject:</span><input data-email-subject="'+esc(task.id)+'" value="Signed Offer/Contract needed for Dr '+esc(gpName)+' - GP Link" /></div>';
      h3+='<div class="ops-email-body" contenteditable="true" data-email-body="'+esc(task.id)+'">'
        +'Hi '+esc(contactName||'')+',<br><br>'
        +'We are preparing the registration documents for Dr '+esc(gpName)+' and need the following: <strong>Offer / Contract</strong> with both the candidate and employer signatures.<br><br>'
        +'Please find attached the contract already signed by the candidate. Could you please counter-sign and return the completed contract at your earliest convenience?<br><br>'
        +'Kind regards,<br>Hazel \u2014 GP Link Registration Team'
        +'</div>';
    } else {
      h3+='<div class="ops-email-field"><span class="ops-email-label">Subject:</span><input data-email-subject="'+esc(task.id)+'" value="'+esc(docTitle)+' needed for Dr '+esc(gpName)+' - GP Link" /></div>';
      h3+='<div class="ops-email-body" contenteditable="true" data-email-body="'+esc(task.id)+'">'
        +'Hi '+esc(contactName||'')+',<br><br>'
        +'We are preparing the registration documents for Dr '+esc(gpName)+' and need the following: <strong>'+esc(docTitle)+'</strong>.<br><br>'
        +'Could you please send this through at your earliest convenience?<br><br>'
        +'Kind regards,<br>Hazel \u2014 GP Link Registration Team'
        +'</div>';
    }
    h3+='<div class="ops-email-actions">';
    h3+='<button class="ops-btn-green" data-ops-send-email="'+esc(task.id)+'" data-ops-case="'+esc(task.case_id||'')+'" data-ops-flip-status="waiting_on_practice"'+(isOfferContractWithDoc?' data-ops-auto-attach="true"':'')+'>Email Practice</button>';
    h3+='</div>';
    h3+='</div>';
    h3+='</div>';
    return h3;
```

- [ ] **Step 2: Modify the send email click handler to include auto-attachments**

Find the email send handler (around line 5178-5204). After the line that constructs the fetch body (around line 5194):

```javascript
body:JSON.stringify({to:toVal,subject:subVal,bodyHtml:bodyHtml,taskId:tid,caseId:caseId})});
```

Replace that section (from where `sendEmailBtn.disabled=true` starts through the fetch call) with:

```javascript
        sendEmailBtn.disabled=true;sendEmailBtn.textContent='Sending\u2026';
        try{
          var emailPayload={to:toVal,subject:subVal,bodyHtml:bodyHtml,taskId:tid,caseId:caseId};
          // Auto-attach contract document if flagged
          var autoAttach=sendEmailBtn.hasAttribute('data-ops-auto-attach');
          if(autoAttach){
            var taskDocs=S._opsDocCache&&S._opsDocCache[tid]?S._opsDocCache[tid]:[];
            var currentDoc=taskDocs.find(function(d){return d.is_current!==false;});
            if(currentDoc&&currentDoc.attachment_url){
              emailPayload.attachments=[{url:currentDoc.attachment_url,filename:currentDoc.filename||'contract'}];
            }
          }
          var r=await fetch('/api/admin/email/send',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
            body:JSON.stringify(emailPayload)});
```

- [ ] **Step 3: Verify admin.html parses correctly**

Open the admin page in a browser or check for syntax errors:
```bash
node -e "var fs=require('fs');var html=fs.readFileSync('pages/admin.html','utf8');console.log('OK, length:',html.length)"
```

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html && git commit -m "feat: auto-attach contract and custom email template for offer/contract tasks"
```

---

### Task 6: Handle data: URI Attachments in Email Send Endpoint

**Files:**
- Modify: `server.js` — in `/api/admin/email/send` attachment resolution (around line 20297-20310)

- [ ] **Step 1: Add data: URI handling to attachment resolution**

The current code uses `fetchAttachmentAsBase64(att.url)` which expects an HTTP URL. For data: URIs (the contract stored as base64), we need to handle them inline.

Find the attachment resolution loop (around line 20297-20310):
```javascript
    var resolvedAttachments = [];
    for (var ati = 0; ati < emailAttachments.length; ati++) {
      var att = emailAttachments[ati];
      if (!att.url) continue;
      try {
        var fetched = await fetchAttachmentAsBase64(att.url, att.filename || null);
        resolvedAttachments.push(fetched);
      } catch (fetchErr) {
        console.error('[AdminEmailSend] Attachment fetch failed:', att.url, fetchErr.message);
        sendJson(res, 400, { ok: false, message: 'Failed to fetch attachment: ' + (att.filename || att.url) + ' — ' + fetchErr.message });
        return;
      }
    }
```

Replace with:

```javascript
    var resolvedAttachments = [];
    for (var ati = 0; ati < emailAttachments.length; ati++) {
      var att = emailAttachments[ati];
      if (!att.url) continue;
      try {
        if (att.url.startsWith('data:')) {
          // Inline data: URI — decode directly
          var commaIdx = att.url.indexOf(',');
          var mimeMatch = att.url.substring(0, commaIdx).match(/data:([^;]+)/);
          var attMime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
          var b64 = att.url.substring(commaIdx + 1).replace(/-/g, '+').replace(/_/g, '/');
          while (b64.length % 4 !== 0) b64 += '=';
          resolvedAttachments.push({ filename: att.filename || 'attachment', mimeType: attMime, content: b64 });
        } else {
          var fetched = await fetchAttachmentAsBase64(att.url, att.filename || null);
          resolvedAttachments.push(fetched);
        }
      } catch (fetchErr) {
        console.error('[AdminEmailSend] Attachment fetch failed:', att.url && att.url.substring(0, 50), fetchErr.message);
        sendJson(res, 400, { ok: false, message: 'Failed to fetch attachment: ' + (att.filename || 'file') + ' — ' + fetchErr.message });
        return;
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add server.js && git commit -m "feat: support data: URI attachments in admin email send"
```

---

### Task 7: Admin UI — View Previous Version and Contract Diff Banner

**Files:**
- Modify: `pages/admin.html` — in `renderOpsPracticePackChild` State B (around line 4140-4167) and the `opsRenderDocs` function

- [ ] **Step 1: Add "View previous version" button and diff banner in State B**

Find the State B section (around line 4140-4167). Modify it to add contract-specific features:

Find this line (around line 4152):
```javascript
      h+=opsRenderDocs(docs);
```

Replace the section from `h+=opsRenderDocs(docs);` through the action row with:

```javascript
      var currentDocs2=docs.filter(function(d){return d.is_current!==false;});
      var prevDocs=docs.filter(function(d){return d.is_current===false;});
      h+=opsRenderDocs(currentDocs2);
      // Offer/contract: show "View previous version" if there's a previous doc
      if(task.related_document_key==='offer_contract'&&prevDocs.length>0){
        h+='<div style="margin:6px 0">';
        prevDocs.forEach(function(pd){
          var pdUrl=pd.google_drive_url||pd.attachment_url||'';
          if(pdUrl){
            h+='<button data-preview-doc="'+esc(pd.id)+'" data-preview-name="'+esc(pd.filename||'Previous version')+'" style="font-size:11px;color:var(--muted);background:none;border:none;cursor:pointer;text-decoration:underline">\uD83D\uDD0D View previous version (candidate-signed only)</button>';
          }
        });
        h+='</div>';
      }
      // Contract diff banner
      if(task.related_document_key==='offer_contract'&&task.contract_diff_summary){
        h+='<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px 14px;margin:8px 0;font-size:12px">';
        h+='<strong>\u26A0\uFE0F Contract changes detected:</strong> '+esc(task.contract_diff_summary);
        h+='</div>';
      }
      h+='<div class="ops-action-row">';
      h+='<button class="ops-btn-green" data-ops-submit-drive="'+esc(task.id)+'">Submit to Drive &amp; Complete</button>';
      h+='<button class="ops-btn-secondary" data-ops-upload-own="'+esc(task.id)+'">Upload Different Version</button>';
      h+='<button class="ops-btn-danger" data-ops-request-revision="'+esc(task.id)+'" data-ops-channel="email" data-ops-case="'+esc(task.case_id||'')+'" data-ops-flip-status="waiting_on_practice">Request Revision</button>';
      h+='</div>';
```

- [ ] **Step 2: Commit**

```bash
git add pages/admin.html && git commit -m "feat: add view previous version button and contract diff banner"
```

---

### Task 8: Expose `contract_diff_summary` to Admin Frontend

**Files:**
- Modify: `server.js` — in the task serialization for admin (search for where tasks are serialized to the frontend, likely in `/api/admin/va/task/list-admin-tasks` or `/api/admin/tasks` GET)

- [ ] **Step 1: Add `contract_diff_summary` column to task query**

Find the admin task list endpoint that serializes tasks to the frontend. Search for where `registration_tasks` are queried with `select=` for the admin ops queue. The task object sent to the frontend needs to include `contract_diff_summary`.

First, we need to store the diff summary. The simplest approach is to use the existing `description` field on `registration_tasks` or add it to the task's metadata. Since `registration_tasks` already has a `description` field, we'll store the diff summary there as a prefix when it's set.

Actually, cleaner approach: store it in the task timeline and read it back. But that adds complexity. Instead, use the task's `ai_match_reasoning` field (already exists on `registration_tasks`) to store the diff summary — it's an existing text field used for AI analysis results.

Find where tasks are serialized in the ops queue. Look for the `GET /api/admin/tasks` endpoint (around line 25915). Check what `select=` fields are included. Add `ai_match_reasoning` if not already present, and alias it as the diff summary source.

In `checkOfferContractAtOnboarding` and the Zoho re-upload code (Task 9), store the diff summary in `ai_match_reasoning` on the task.

In the frontend `renderOpsPracticePackChild`, read it as:
```javascript
task.contract_diff_summary = task.ai_match_reasoning || '';
```

But actually, `ai_match_reasoning` is already serialized to frontend (line 26727 found earlier). So we just need to read it in the render function.

Update the State B render code. Change:
```javascript
if(task.related_document_key==='offer_contract'&&task.contract_diff_summary){
```
to:
```javascript
if(task.related_document_key==='offer_contract'&&task.ai_match_reasoning&&task.ai_match_reasoning.indexOf('Contract changes')===0){
```

Actually, simpler: just use `task.ai_match_reasoning` directly as the diff summary field. When the diff is stored, prefix it so we can identify it:

In the diff storage code (Task 9), store as: `"Contract changes: " + diffSummary`

In the frontend, check for and display it:
```javascript
var diffSummary=(task.ai_match_reasoning||'');
if(task.related_document_key==='offer_contract'&&diffSummary){
```

- [ ] **Step 1: Verify `ai_match_reasoning` is already in the task select query**

Search the ops tasks endpoint to confirm. If it's included in `select=*` queries, no backend change needed.

- [ ] **Step 2: Update State B render to use `ai_match_reasoning`**

In the code from Task 7 Step 1, replace:
```javascript
      if(task.related_document_key==='offer_contract'&&task.contract_diff_summary){
        h+='<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px 14px;margin:8px 0;font-size:12px">';
        h+='<strong>\u26A0\uFE0F Contract changes detected:</strong> '+esc(task.contract_diff_summary);
        h+='</div>';
      }
```

With:
```javascript
      var diffNote=task.ai_match_reasoning||'';
      if(task.related_document_key==='offer_contract'&&diffNote){
        h+='<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px 14px;margin:8px 0;font-size:12px">';
        h+='<strong>\u26A0\uFE0F Contract analysis:</strong> '+esc(diffNote);
        h+='</div>';
      }
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html && git commit -m "feat: show AI contract analysis in amber banner on offer/contract tasks"
```

---

### Task 9: Submit to Drive — Delete Old Incomplete Contract

**Files:**
- Modify: `server.js` — in `/api/admin/task/submit-drive` endpoint (around line 26195-26324)

- [ ] **Step 1: Add old Drive file deletion for offer_contract tasks**

Find the section after the Drive upload and before the user_documents update (around line 26253). Insert after the `uploadToGoogleDrive` call:

```javascript
    // For offer_contract: delete the old incomplete contract from Drive if it exists
    if (docKey === 'offer_contract' && regCase && regCase.user_id) {
      try {
        var oldUdRes = await supabaseDbRequest('user_documents',
          'select=google_drive_file_id&user_id=eq.' + encodeURIComponent(regCase.user_id) + '&document_key=eq.offer_contract&limit=1');
        var oldUd = oldUdRes.ok && Array.isArray(oldUdRes.data) && oldUdRes.data[0] ? oldUdRes.data[0] : null;
        if (oldUd && oldUd.google_drive_file_id && oldUd.google_drive_file_id !== (driveFile && driveFile.id)) {
          var drive2 = await getGoogleDriveClient();
          if (drive2) {
            await drive2.files.delete({ fileId: oldUd.google_drive_file_id }).catch(function (e) {
              console.log('[AdminSubmitDrive] Could not delete old contract from Drive:', e.message);
            });
            console.log('[AdminSubmitDrive] Deleted old incomplete contract from Drive:', oldUd.google_drive_file_id);
          }
        }
      } catch (delErr) {
        console.error('[AdminSubmitDrive] Error checking old contract:', delErr.message);
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add server.js && git commit -m "feat: delete old incomplete contract from Drive on submit"
```

---

### Task 10: Zoho Re-upload Detection in Sync

**Files:**
- Modify: `server.js` — in `syncZohoRecruitApplicationStatuses()` (around line 11413-11509)

- [ ] **Step 1: Add contract re-upload check in the sync loop**

Find the main loop in `syncZohoRecruitApplicationStatuses` (around line 11427, the `for (const app of localApps)` loop). After the `if (!liveRecord) continue;` line, insert the re-upload check:

```javascript
      // Check for contract re-upload on Zoho
      if (app.user_id) {
        try {
          await checkZohoContractReupload(zoho, app);
        } catch (reupErr) {
          console.error('[ZohoSync] Contract re-upload check failed for app', app.zoho_application_id, ':', reupErr.message);
        }
      }
```

Then add the `checkZohoContractReupload` function near the other contract functions (after `checkOfferContractAtOnboarding`):

```javascript
/**
 * During Zoho sync, check if a new contract has been uploaded for an application.
 * If the attachment ID differs from what's stored on the task, re-scan and diff.
 */
async function checkZohoContractReupload(zoho, app) {
  if (!app.user_id || !app.zoho_application_id) return;

  // Find the existing offer_contract task for this user's case
  var caseRes = await supabaseDbRequest('registration_cases',
    'select=id&user_id=eq.' + encodeURIComponent(app.user_id) + '&limit=1');
  var caseRow = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0] : null;
  if (!caseRow) return;

  var taskRes = await supabaseDbRequest('registration_tasks',
    'select=id,zoho_attachment_id,status&case_id=eq.' + encodeURIComponent(caseRow.id) + '&related_document_key=eq.offer_contract&task_type=eq.practice_pack_child&limit=1');
  var task = taskRes.ok && Array.isArray(taskRes.data) && taskRes.data[0] ? taskRes.data[0] : null;
  // If no task exists yet and no completed task, we may still want to check
  // But only proceed if there's an existing task to compare against
  if (!task) return;
  // Skip completed tasks — the contract was already accepted
  if (task.status === 'completed' || task.status === 'cancelled') return;

  // List current Zoho attachments
  var attachments = await listZohoRecruitApplicationAttachments(
    { connection: zoho.connection, accessToken: zoho.accessToken, apiDomain: zoho.apiDomain },
    app.zoho_application_id
  );
  var candidates = selectZohoContractAttachmentCandidates(attachments);
  if (!candidates.length) return;

  var topCandidate = candidates[0];
  var currentZohoId = topCandidate.id || '';
  var storedZohoId = task.zoho_attachment_id || '';

  // No change
  if (currentZohoId === storedZohoId) return;

  console.log('[ZohoSync] Contract re-upload detected for app', app.zoho_application_id, '— old:', storedZohoId, 'new:', currentZohoId);

  // Download the new contract
  var newBuffer = null;
  try {
    newBuffer = await downloadZohoRecruitApplicationAttachment(
      { connection: zoho.connection, accessToken: zoho.accessToken, apiDomain: zoho.apiDomain },
      app.zoho_application_id, topCandidate.id
    );
  } catch (e) {}
  if (!newBuffer || newBuffer.length === 0) return;

  var newMime = topCandidate.mimeType || topCandidate.content_type || 'application/pdf';
  var newFilename = topCandidate.fileName || topCandidate.File_Name || 'contract.pdf';

  // AI signature scan on new contract
  var scanResult = await scanContractSignatures(newBuffer, newMime, newFilename);
  console.log('[ZohoSync] Re-upload scan:', JSON.stringify(scanResult));

  // Diff against old contract (fetch from task_documents)
  var diffSummary = '';
  var oldDocRes = await supabaseDbRequest('task_documents',
    'select=attachment_url,mime_type&task_id=eq.' + encodeURIComponent(task.id) + '&is_current=eq.true&limit=1');
  var oldDoc = oldDocRes.ok && Array.isArray(oldDocRes.data) && oldDocRes.data[0] ? oldDocRes.data[0] : null;
  if (oldDoc && oldDoc.attachment_url && oldDoc.attachment_url.startsWith('data:')) {
    try {
      var commaIdx = oldDoc.attachment_url.indexOf(',');
      var oldMimeMatch = oldDoc.attachment_url.substring(0, commaIdx).match(/data:([^;]+)/);
      var oldMime = oldMimeMatch ? oldMimeMatch[1] : 'application/pdf';
      var oldB64 = oldDoc.attachment_url.substring(commaIdx + 1).replace(/-/g, '+').replace(/_/g, '/');
      while (oldB64.length % 4 !== 0) oldB64 += '=';
      var oldBuffer = Buffer.from(oldB64, 'base64');
      diffSummary = await diffContracts(oldBuffer, oldMime, newBuffer, newMime);
    } catch (diffErr) {
      console.error('[ZohoSync] Contract diff error:', diffErr.message);
    }
  }

  // Update the task
  var newDataUrl = 'data:' + newMime + ';base64,' + newBuffer.toString('base64');
  var taskPatch = {
    zoho_attachment_id: currentZohoId,
    attachment_url: newDataUrl,
    attachment_filename: newFilename,
    updated_at: new Date().toISOString()
  };
  if (diffSummary) taskPatch.ai_match_reasoning = diffSummary;

  // Mark previous task_documents as not current, insert new
  await supabaseDbRequest('task_documents', 'task_id=eq.' + encodeURIComponent(task.id) + '&is_current=eq.true',
    { method: 'PATCH', body: { is_current: false } });
  await supabaseDbRequest('task_documents', '', {
    method: 'POST',
    body: [{
      task_id: task.id,
      case_id: caseRow.id,
      filename: newFilename,
      mime_type: newMime,
      size_bytes: newBuffer.length,
      version: 1,
      is_current: true,
      uploaded_by: 'zoho_reupload',
      attachment_url: newDataUrl
    }]
  });

  if (scanResult.has_candidate_signature && scanResult.has_employer_signature) {
    // Both signatures now — auto-complete
    console.log('[ZohoSync] New contract has both signatures — auto-completing');
    await deliverOfferContract(app.user_id, caseRow.id, app.zoho_application_id, app.zoho_candidate_id);
    taskPatch.status = 'completed';
    taskPatch.completed_at = new Date().toISOString();
    taskPatch.completed_by = 'system';
    await _logCaseEvent(caseRow.id, task.id, 'completed', 'New Zoho contract has both signatures — auto-completed', diffSummary || '', 'system');
  } else {
    // Still single-signature — keep/reopen task
    if (task.status !== 'open' && task.status !== 'waiting_on_practice') {
      taskPatch.status = 'open';
    }
    var timelineNote = 'New contract uploaded in Zoho (re-scan: ' +
      (scanResult.has_employer_signature ? 'employer signed' : 'employer signature still missing') + ')';
    if (diffSummary) timelineNote += ' | Changes: ' + diffSummary.slice(0, 200);
    await _logCaseEvent(caseRow.id, task.id, 'note', timelineNote, null, 'system');
  }

  await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(task.id), {
    method: 'PATCH', body: taskPatch
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add server.js && git commit -m "feat: detect and process Zoho contract re-uploads during sync"
```

---

### Task 11: Final Verification and Push

- [ ] **Step 1: Verify server starts without errors**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)" && lsof -ti:3000 | xargs kill -9 2>/dev/null; NODE_ENV=development node server.js &
sleep 2 && curl -s http://localhost:3000/pages/admin.html | head -c 200
kill %1
```

- [ ] **Step 2: Run existing tests**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)" && npm test
```

- [ ] **Step 3: Push to remote**

```bash
git push
```

- [ ] **Step 4: Deploy to production**

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 /usr/local/Cellar/node@18/18.20.8/bin/vercel --prod --yes
```
