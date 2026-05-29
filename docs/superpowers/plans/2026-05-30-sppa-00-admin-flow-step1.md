# SPPA-00 Admin Flow — Step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Zoho Sign SPPA-00 flow with an email-based workflow: AI scans supervisor CV + offer/contract to detect conflict of interest, programmatically fills Q7 on the SPPA-00 PDF, then VA sends via Gmail. Also adds AHPRA email pipeline for officer correspondence.

**Architecture:** When both supervisor_cv and offer_contract tasks are completed, an AI scan (Opus) cross-checks names from both documents + MRCGP certificate to detect if the supervisor is the practice owner. pdf-lib fills Q7 on the SPPA-00 PDF form. The VA reviews, optionally overrides, then emails the PDF to the candidate and practice via the existing Gmail integration. Inbound `@ahpra.gov.au` emails are classified by the triage pipeline and create appropriate admin tasks.

**Tech Stack:** Node.js, pdf-lib (PDF form filling), Anthropic Claude API (Opus for conflict scan, Opus for AHPRA classification), Gmail API (existing integration), Supabase PostgreSQL

**Spec:** `docs/superpowers/specs/2026-05-30-sppa-00-admin-flow-step1-design.md`

---

### Task 1: Install pdf-lib and add SPPA-00 template

**Files:**
- Modify: `package.json`
- Create: `documents/sppa-00-template.pdf`

- [ ] **Step 1: Install pdf-lib**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)" && npm install pdf-lib
```

- [ ] **Step 2: Copy the SPPA-00 template PDF into the repo**

```bash
cp "/Users/khaleed/Desktop/SPPA-00 AHPRA __ GP LINK RECRUITMENT.pdf" "/Users/khaleed/GP LINK APP (Visual Studio)/documents/sppa-00-template.pdf"
```

- [ ] **Step 3: Verify the PDF form fields are readable with pdf-lib**

Create a temporary test script `_test-pdf-fields.js` in the project root:

```javascript
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  const pdfBytes = fs.readFileSync('./documents/sppa-00-template.pdf');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  for (const f of fields) {
    console.log(f.getName(), f.constructor.name);
  }
  // Specifically check Q7
  try {
    const q7 = form.getRadioGroup('q7');
    console.log('\nQ7 radio options:', q7.getOptions());
  } catch (e) {
    console.log('\nQ7 lookup error:', e.message);
  }
  try {
    const q7text = form.getTextField('Conflicts_Question7');
    console.log('Q7 text field found:', q7text.getName());
  } catch (e) {
    console.log('Q7 text field error:', e.message);
  }
})();
```

Run: `node _test-pdf-fields.js`

Expected: Lists all form fields. Q7 radio group found with two options. `Conflicts_Question7` text field found. Record the exact Q7 radio option names from the output — they will be needed in Task 3.

- [ ] **Step 4: Delete the test script and commit**

```bash
rm _test-pdf-fields.js
git add package.json package-lock.json documents/sppa-00-template.pdf
git commit -m "chore: add pdf-lib dependency and SPPA-00 template PDF"
```

---

### Task 2: Create lib/sppa-conflict-scan.js — AI conflict scan

**Files:**
- Create: `lib/sppa-conflict-scan.js`

This module takes document buffers (supervisor CV, offer/contract, MRCGP cert) plus the candidate's profile name, sends them to Claude Opus in a single API call, and returns a structured conflict-of-interest result.

- [ ] **Step 1: Create lib/sppa-conflict-scan.js**

```javascript
'use strict';

var CONFLICT_SCAN_SYSTEM_PROMPT = [
  'You are a document analyst for GP Link, an Australian GP recruitment platform.',
  'You will receive up to four inputs:',
  '1. A Supervisor CV (PDF or image)',
  '2. An Offer/Contract between a GP candidate and a medical practice (PDF or image)',
  '3. An MRCGP certificate belonging to the GP candidate (PDF or image) — this is the most authoritative source for the candidate\'s name',
  '4. The GP candidate\'s name from their registration profile (text)',
  '',
  'Your task:',
  '1. Extract the supervisor\'s full name from the CV.',
  '2. Extract the employer, director, signatory, owner, or principal name(s) from the contract. Look for labels like "director", "owner", "principal", "employer", "signatory", or the signing block at the end.',
  '3. Extract the GP candidate\'s name from the MRCGP certificate and cross-check with the contract — the candidate appears in the contract as the "consultant", "employee", or "contractor". Use fuzzy matching across all name sources to reliably identify which person is the candidate.',
  '4. After excluding the candidate, compare the supervisor name from the CV against the practice owner/director/signatory from the contract.',
  '5. If the supervisor and the practice owner/director are the same person (or very likely the same person with minor name variations), this is a conflict of interest.',
  '',
  'Return ONLY valid JSON:',
  '{',
  '  "supervisor_name": "Full name from CV",',
  '  "practice_owner_name": "Full name of director/owner/signatory from contract",',
  '  "candidate_name": "Full name of GP candidate (best match across all sources)",',
  '  "is_conflict": true/false,',
  '  "confidence": "high" | "medium" | "low",',
  '  "reasoning": "One or two sentences explaining your determination"',
  '}'
].join('\n');

function parseConflictScanResponse(text) {
  var defaults = {
    supervisor_name: '',
    practice_owner_name: '',
    candidate_name: '',
    is_conflict: false,
    confidence: 'low',
    reasoning: 'Could not parse AI response'
  };
  try {
    var start = String(text || '').indexOf('{');
    var end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    var parsed = JSON.parse(String(text).slice(start, end + 1));
    var validConfidence = ['high', 'medium', 'low'];
    return {
      supervisor_name: String(parsed.supervisor_name || '').trim(),
      practice_owner_name: String(parsed.practice_owner_name || '').trim(),
      candidate_name: String(parsed.candidate_name || '').trim(),
      is_conflict: !!parsed.is_conflict,
      confidence: validConfidence.includes(parsed.confidence) ? parsed.confidence : 'low',
      reasoning: String(parsed.reasoning || '').trim()
    };
  } catch (e) {
    return defaults;
  }
}

/**
 * Run the AI conflict-of-interest scan.
 *
 * @param {Object} params
 * @param {Buffer} params.supervisorCvBuffer - Supervisor CV file buffer
 * @param {string} params.supervisorCvMime - MIME type of the CV (e.g. 'application/pdf')
 * @param {Buffer} params.contractBuffer - Offer/contract file buffer
 * @param {string} params.contractMime - MIME type of the contract
 * @param {Buffer|null} params.mrcgpBuffer - MRCGP certificate buffer (optional but recommended)
 * @param {string|null} params.mrcgpMime - MIME type of the MRCGP cert
 * @param {string} params.candidateName - Candidate name from profile (fallback)
 * @param {Object} [opts]
 * @param {string} [opts.apiKey] - Anthropic API key override
 * @returns {Promise<Object>} Structured conflict scan result
 */
async function scanForConflict(params, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Object.assign(parseConflictScanResponse(''), { _error: 'no_api_key' });
  }

  // Build content blocks with documents
  var contentBlocks = [];

  // 1. Supervisor CV
  contentBlocks.push({ type: 'text', text: '## Supervisor CV (Document 1)' });
  var cvMediaType = params.supervisorCvMime || 'application/pdf';
  if (/pdf/i.test(cvMediaType)) {
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: params.supervisorCvBuffer.toString('base64') }
    });
  } else {
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: cvMediaType, data: params.supervisorCvBuffer.toString('base64') }
    });
  }

  // 2. Offer/Contract
  contentBlocks.push({ type: 'text', text: '## Offer/Contract (Document 2)' });
  var contractMediaType = params.contractMime || 'application/pdf';
  if (/pdf/i.test(contractMediaType)) {
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: params.contractBuffer.toString('base64') }
    });
  } else {
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: contractMediaType, data: params.contractBuffer.toString('base64') }
    });
  }

  // 3. MRCGP certificate (optional)
  if (params.mrcgpBuffer) {
    contentBlocks.push({ type: 'text', text: '## MRCGP Certificate (Document 3) — authoritative candidate name source' });
    var mrcgpMediaType = params.mrcgpMime || 'application/pdf';
    if (/pdf/i.test(mrcgpMediaType)) {
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: params.mrcgpBuffer.toString('base64') }
      });
    } else {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mrcgpMediaType, data: params.mrcgpBuffer.toString('base64') }
      });
    }
  }

  // 4. Candidate name from profile
  contentBlocks.push({
    type: 'text',
    text: '## Candidate profile name (fallback)\n' + (params.candidateName || 'Not provided')
  });

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 60000);
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 800,
        system: [{ type: 'text', text: CONFLICT_SCAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: contentBlocks }]
      })
    });
    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (e) {}
      return Object.assign(parseConflictScanResponse(''), { _error: 'api_error_' + resp.status, _detail: errBody });
    }
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var parsed = parseConflictScanResponse(text);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return Object.assign(parseConflictScanResponse(''), { _error: 'fetch_error: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { scanForConflict, parseConflictScanResponse, CONFLICT_SCAN_SYSTEM_PROMPT };
```

- [ ] **Step 2: Commit**

```bash
git add lib/sppa-conflict-scan.js
git commit -m "feat: add AI conflict-of-interest scan for SPPA-00 (Opus)"
```

---

### Task 3: Create lib/sppa-pdf-fill.js — PDF Q7 form filling

**Files:**
- Create: `lib/sppa-pdf-fill.js`

Uses pdf-lib to load the SPPA-00 template and fill Q7 checkbox + text field. Returns a Buffer of the modified PDF.

**Important:** The Q7 radio button option names (the internal values for YES and NO) must be discovered from Task 1 Step 3 output. The code below uses placeholder option indices — the subagent MUST verify the exact option names/indices by running the test script first.

- [ ] **Step 1: Create lib/sppa-pdf-fill.js**

```javascript
'use strict';

var fs = require('fs');
var path = require('path');
var { PDFDocument } = require('pdf-lib');

var TEMPLATE_PATH = path.join(__dirname, '..', 'documents', 'sppa-00-template.pdf');

var CONFLICT_DETAILS_TEXT =
  'The supervisor is the practice owner. An email to the AHPRA officer will be sent directly ' +
  'explaining how any future potential conflicts of interest will be handled.';

/**
 * Fill Q7 on the SPPA-00 PDF template.
 *
 * @param {Object} params
 * @param {boolean} params.isConflict - true = YES, false = NO
 * @param {string} [params.detailsText] - Custom details text (defaults to standard conflict message when isConflict=true)
 * @returns {Promise<Buffer>} Modified PDF as a Node.js Buffer
 */
async function fillSppaQ7(params) {
  var templateBytes = fs.readFileSync(TEMPLATE_PATH);
  var pdfDoc = await PDFDocument.load(templateBytes);
  var form = pdfDoc.getForm();

  // Q7 radio group — two options: index 0 = YES, index 1 = NO
  var q7Radio = form.getRadioGroup('q7');
  var options = q7Radio.getOptions();

  if (params.isConflict) {
    // Select YES (first option)
    q7Radio.select(options[0]);
    // Fill details text
    var q7Text = form.getTextField('Conflicts_Question7');
    var details = params.detailsText || CONFLICT_DETAILS_TEXT;
    q7Text.setText(details);
  } else {
    // Select NO (second option)
    q7Radio.select(options[1]);
  }

  var pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { fillSppaQ7, CONFLICT_DETAILS_TEXT };
```

- [ ] **Step 2: Verify form filling works**

Create temporary test `_test-pdf-fill.js`:

```javascript
const { fillSppaQ7 } = require('./lib/sppa-pdf-fill');
const fs = require('fs');

(async () => {
  // Test YES
  var yesBuffer = await fillSppaQ7({ isConflict: true });
  fs.writeFileSync('/tmp/sppa-q7-yes.pdf', yesBuffer);
  console.log('YES PDF written to /tmp/sppa-q7-yes.pdf (' + yesBuffer.length + ' bytes)');

  // Test NO
  var noBuffer = await fillSppaQ7({ isConflict: false });
  fs.writeFileSync('/tmp/sppa-q7-no.pdf', noBuffer);
  console.log('NO PDF written to /tmp/sppa-q7-no.pdf (' + noBuffer.length + ' bytes)');

  console.log('Open both PDFs and verify Q7 checkbox + text are correct.');
})();
```

Run: `node _test-pdf-fill.js`

Expected: Two PDFs written. Open `/tmp/sppa-q7-yes.pdf` — Q7 YES checkbox ticked, details text filled. Open `/tmp/sppa-q7-no.pdf` — Q7 NO checkbox ticked, details blank.

**If the radio button selection doesn't work as expected** (e.g. wrong option selected, or pdf-lib throws about the radio group), adjust the option index or use the exact option name string from the Task 1 Step 3 output. Some AHPRA PDF forms use hash-like option names instead of simple indices.

- [ ] **Step 3: Delete test script and commit**

```bash
rm _test-pdf-fill.js
git add lib/sppa-pdf-fill.js
git commit -m "feat: add SPPA-00 Q7 PDF form filler (pdf-lib)"
```

---

### Task 4: Add unlock trigger and conflict scan to task completion in server.js

**Files:**
- Modify: `server.js` — after `_completeRegTask()` (around line 6447), and inside the `/api/admin/va/task/approve-document` handler (around line 29163)

When a `supervisor_cv` or `offer_contract` task is completed, check if the sibling is also complete. If both are done, fire the AI conflict scan, fill the SPPA-00 PDF, store it on the SPPA-00 task, and update the task status.

- [ ] **Step 1: Add require statements at the top of server.js**

Find the existing require block near the top of `server.js` (around line 88 where `require('./lib/zoho-sign.js')` is). Add after the existing lib requires:

```javascript
const { scanForConflict } = require('./lib/sppa-conflict-scan.js');
const { fillSppaQ7 } = require('./lib/sppa-pdf-fill.js');
```

- [ ] **Step 2: Add the conflict scan + PDF fill orchestrator function**

Insert after `_logCaseEvent()` (around line 6456) in `server.js`:

```javascript
/**
 * Check if both supervisor_cv and offer_contract are complete for a case,
 * then fire the AI conflict scan and fill Q7 on the SPPA-00 PDF.
 * Called as a side-effect when either document task is completed.
 */
async function _maybeRunSppaConflictScan(caseId, userId) {
  try {
    // 1. Check both prerequisite tasks are complete
    var siblingRes = await supabaseDbRequest('registration_tasks',
      'select=id,related_document_key,status&case_id=eq.' + encodeURIComponent(caseId) +
      '&related_document_key=in.(supervisor_cv,offer_contract)&task_type=eq.practice_pack_child');
    if (!siblingRes.ok || !Array.isArray(siblingRes.data)) return;
    var tasks = siblingRes.data;
    var svDone = tasks.some(function (t) { return t.related_document_key === 'supervisor_cv' && t.status === 'completed'; });
    var ocDone = tasks.some(function (t) { return t.related_document_key === 'offer_contract' && t.status === 'completed'; });
    if (!svDone || !ocDone) return; // Not both complete yet

    // 2. Find the SPPA-00 task
    var sppaRes = await supabaseDbRequest('registration_tasks',
      'select=id,status,metadata&case_id=eq.' + encodeURIComponent(caseId) +
      '&related_document_key=eq.sppa_00&task_type=eq.practice_pack_child&limit=1');
    if (!sppaRes.ok || !sppaRes.data || !sppaRes.data[0]) return;
    var sppaTask = sppaRes.data[0];

    // Skip if already scanned (idempotency)
    var existingMeta = sppaTask.metadata;
    if (typeof existingMeta === 'string') try { existingMeta = JSON.parse(existingMeta); } catch (e) { existingMeta = {}; }
    if (existingMeta && existingMeta.conflict_scan_completed) return;

    console.log('[SPPA-00] Both supervisor_cv + offer_contract complete for case ' + caseId + ' — running conflict scan');

    // 3. Gather document buffers
    // 3a. Supervisor CV — from task_documents
    var svTask = tasks.find(function (t) { return t.related_document_key === 'supervisor_cv'; });
    var svDocRes = await supabaseDbRequest('task_documents',
      'select=attachment_url,mime_type&task_id=eq.' + encodeURIComponent(svTask.id) + '&is_current=eq.true&limit=1');
    var svDoc = svDocRes.ok && svDocRes.data && svDocRes.data[0] ? svDocRes.data[0] : null;

    // 3b. Offer/Contract — from task_documents
    var ocTask = tasks.find(function (t) { return t.related_document_key === 'offer_contract'; });
    var ocDocRes = await supabaseDbRequest('task_documents',
      'select=attachment_url,mime_type&task_id=eq.' + encodeURIComponent(ocTask.id) + '&is_current=eq.true&limit=1');
    var ocDoc = ocDocRes.ok && ocDocRes.data && ocDocRes.data[0] ? ocDocRes.data[0] : null;

    if (!svDoc || !svDoc.attachment_url || !ocDoc || !ocDoc.attachment_url) {
      console.error('[SPPA-00] Missing document attachments for conflict scan');
      return;
    }

    // Decode data URL buffers
    function decodeDataUrl(dataUrl) {
      var commaIdx = dataUrl.indexOf(',');
      var mimeMatch = dataUrl.substring(0, commaIdx).match(/data:([^;]+)/);
      var mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
      var b64 = dataUrl.substring(commaIdx + 1).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';
      return { buffer: Buffer.from(b64, 'base64'), mimeType: mime };
    }

    var svDecoded = decodeDataUrl(svDoc.attachment_url);
    var ocDecoded = decodeDataUrl(ocDoc.attachment_url);

    // 3c. MRCGP certificate — from user_documents via Supabase storage
    var mrcgpBuffer = null;
    var mrcgpMime = null;
    try {
      var mrcgpDocRes = await supabaseDbRequest('user_documents',
        'select=storage_path,file_url,mime_type&user_id=eq.' + encodeURIComponent(userId) +
        '&document_key=eq.mrcgp_certified&limit=1');
      var mrcgpDoc = mrcgpDocRes.ok && mrcgpDocRes.data && mrcgpDocRes.data[0] ? mrcgpDocRes.data[0] : null;
      if (mrcgpDoc) {
        var storagePath = mrcgpDoc.storage_path || mrcgpDoc.file_url || '';
        if (storagePath) {
          var downloaded = await supabaseStorageDownloadObject(SUPABASE_DOCUMENT_BUCKET, storagePath);
          if (downloaded && downloaded.buffer) {
            mrcgpBuffer = downloaded.buffer;
            mrcgpMime = downloaded.mimeType || mrcgpDoc.mime_type || 'application/pdf';
          }
        }
      }
    } catch (mrcgpErr) {
      console.error('[SPPA-00] MRCGP cert fetch error (non-fatal):', mrcgpErr.message);
    }

    // 3d. Candidate profile name
    var profRes = await supabaseDbRequest('user_profiles',
      'select=first_name,last_name&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    var prof = (profRes.ok && profRes.data && profRes.data[0]) ? profRes.data[0] : {};
    var candidateName = ((prof.first_name || '') + ' ' + (prof.last_name || '')).trim();

    // 4. Run AI conflict scan
    var scanResult = await scanForConflict({
      supervisorCvBuffer: svDecoded.buffer,
      supervisorCvMime: svDecoded.mimeType,
      contractBuffer: ocDecoded.buffer,
      contractMime: ocDecoded.mimeType,
      mrcgpBuffer: mrcgpBuffer,
      mrcgpMime: mrcgpMime,
      candidateName: candidateName
    });

    console.log('[SPPA-00] Conflict scan result:', JSON.stringify({
      is_conflict: scanResult.is_conflict,
      confidence: scanResult.confidence,
      supervisor: scanResult.supervisor_name,
      owner: scanResult.practice_owner_name,
      _error: scanResult._error || null
    }));

    // 5. Fill SPPA-00 PDF with Q7
    var filledPdfBuffer = await fillSppaQ7({ isConflict: scanResult.is_conflict });

    // 6. Store the filled PDF as a task_document on the SPPA-00 task
    var pdfDataUrl = 'data:application/pdf;base64,' + filledPdfBuffer.toString('base64');
    await supabaseDbRequest('task_documents', '', {
      method: 'POST',
      body: [{
        task_id: sppaTask.id,
        case_id: caseId,
        filename: 'SPPA-00.pdf',
        mime_type: 'application/pdf',
        size_bytes: filledPdfBuffer.length,
        version: 1,
        is_current: true,
        uploaded_by: 'system_conflict_scan',
        attachment_url: pdfDataUrl
      }]
    });

    // 7. Update the SPPA-00 task — unlock it + store scan metadata
    var meta = {
      conflict_scan_completed: true,
      conflict_scan_at: new Date().toISOString(),
      is_conflict: scanResult.is_conflict,
      confidence: scanResult.confidence,
      supervisor_name: scanResult.supervisor_name,
      practice_owner_name: scanResult.practice_owner_name,
      candidate_name: scanResult.candidate_name,
      reasoning: scanResult.reasoning,
      sppa_state: 'ready_to_send'
    };
    await supabaseDbRequest('registration_tasks',
      'id=eq.' + encodeURIComponent(sppaTask.id),
      { method: 'PATCH', body: { status: 'in_progress', metadata: meta, updated_at: new Date().toISOString() } });

    // 8. Log timeline event
    await _logCaseEvent(caseId, sppaTask.id, 'system',
      'AI conflict scan complete — Q7 marked ' + (scanResult.is_conflict ? 'YES' : 'NO'),
      scanResult.reasoning,
      'system',
      { is_conflict: scanResult.is_conflict, confidence: scanResult.confidence });

  } catch (err) {
    console.error('[SPPA-00] Conflict scan orchestrator error:', err.message);
  }
}
```

- [ ] **Step 3: Wire the trigger into the approve-document endpoint**

In `server.js`, find the `/api/admin/va/task/approve-document` handler (around line 29163). After the line:

```javascript
    await _logCaseEvent(task.case_id, taskId, 'system', (label ? label.label : docKey) + ' approved and delivered to GP', null, adminCtx.email);
```

Add the conflict scan trigger:

```javascript
    // Fire SPPA-00 conflict scan if we just completed a prerequisite document
    if (docKey === 'supervisor_cv' || docKey === 'offer_contract') {
      _maybeRunSppaConflictScan(task.case_id, userId).catch(function (err) {
        console.error('[SPPA-00] async conflict scan error:', err.message);
      });
    }
```

Note: This is fire-and-forget (non-blocking) — the approve-document response returns immediately while the scan runs in the background.

- [ ] **Step 4: Remove the old auto-send SPPA-00 via Zoho Sign**

In `server.js`, find the auto-send block (around line 6986):

```javascript
      // Auto-send SPPA-00 if Zoho Sign is connected + practice contact email is present
```

Comment out or remove the entire auto-send block (from the comment through the closing `}` of the try/catch, approximately lines 6986-6998). Replace with a comment:

```javascript
      // SPPA-00 auto-send removed — now triggered via conflict scan when supervisor_cv + offer_contract are both complete
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add SPPA-00 conflict scan trigger on prerequisite doc completion"
```

---

### Task 5: Create new SPPA-00 email-based endpoints in server.js

**Files:**
- Modify: `server.js` — replace the Zoho Sign SPPA-00 endpoints (around lines 28668-28760)

Replace the old Zoho Sign endpoints with email-based ones. The old endpoints to replace:
- `POST .../send-sppa` (line 28668)
- `GET .../sppa-pdf` (line 28678)
- `POST .../sppa-approve` (line 28694)
- `POST .../sppa-request-correction` (line 28738)

- [ ] **Step 1: Replace the send-sppa endpoint**

Find and replace the `// ── Manual send SPPA-00 via Zoho Sign ──` block (lines 28667-28675). Replace the entire block with:

```javascript
  // ── Send SPPA-00 PDF to candidate via Gmail ──
  if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-send-to-candidate')) {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const taskId = pathname.split('/')[5];

    const taskRes = await supabaseDbRequest('registration_tasks',
      'select=id,case_id,metadata&id=eq.' + encodeURIComponent(taskId) + '&related_document_key=eq.sppa_00&limit=1');
    if (!taskRes.ok || !taskRes.data || !taskRes.data[0]) { sendJson(res, 404, { error: 'task not found' }); return; }
    const task = taskRes.data[0];
    var taskMeta = task.metadata;
    if (typeof taskMeta === 'string') try { taskMeta = JSON.parse(taskMeta); } catch (e) { taskMeta = {}; }
    if (!taskMeta || taskMeta.sppa_state !== 'ready_to_send') { sendJson(res, 400, { error: 'SPPA not ready to send' }); return; }

    // Get the filled PDF
    const docRes = await supabaseDbRequest('task_documents',
      'select=attachment_url&task_id=eq.' + encodeURIComponent(taskId) + '&is_current=eq.true&limit=1');
    const doc = docRes.ok && docRes.data && docRes.data[0] ? docRes.data[0] : null;
    if (!doc || !doc.attachment_url) { sendJson(res, 400, { error: 'No SPPA PDF found' }); return; }

    // Get candidate email
    const caseRes = await supabaseDbRequest('registration_cases',
      'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    const userId = caseRes.ok && caseRes.data && caseRes.data[0] ? caseRes.data[0].user_id : null;
    if (!userId) { sendJson(res, 404, { error: 'case not found' }); return; }

    const profRes = await supabaseDbRequest('user_profiles',
      'select=first_name,last_name,email&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const prof = (profRes.ok && profRes.data && profRes.data[0]) ? profRes.data[0] : {};
    const candidateEmail = String(prof.email || '').trim();
    const candidateName = ((prof.first_name || '') + ' ' + (prof.last_name || '')).trim();
    if (!candidateEmail) { sendJson(res, 400, { error: 'candidate email missing' }); return; }

    // Extract base64 from data URL for attachment
    const commaIdx = doc.attachment_url.indexOf(',');
    const pdfBase64 = doc.attachment_url.substring(commaIdx + 1);

    // Send via Gmail
    const emailResult = await sendGmailEmail({
      from: 'hazel@mygplink.com.au',
      to: candidateEmail,
      subject: 'SPPA-00 Supervised Practice Plan — Please Complete Section A and Sign',
      bodyHtml: '<p>Dear ' + (candidateName || 'Doctor') + ',</p>' +
        '<p>Please find attached your Supervised Practice Plan Agreement (SPPA-00).</p>' +
        '<p>Could you please:</p>' +
        '<ol>' +
        '<li>Complete <b>Section A</b> (Question 1 — your personal details)</li>' +
        '<li>Sign <b>Section I</b> (Supervisee\'s declaration)</li>' +
        '</ol>' +
        '<p>Once completed, please reply to this email with the signed document attached.</p>' +
        '<p>Kind regards,<br>GP Link Registration Team</p>',
      attachments: [{
        filename: 'SPPA-00.pdf',
        mimeType: 'application/pdf',
        content: pdfBase64
      }]
    });
    if (!emailResult.ok) { sendJson(res, 502, { error: 'Failed to send email: ' + (emailResult.error || '') }); return; }

    // Update task metadata state
    taskMeta.sppa_state = 'sent_to_candidate';
    taskMeta.sent_to_candidate_at = new Date().toISOString();
    taskMeta.sent_to_candidate_email = candidateEmail;
    taskMeta.candidate_gmail_message_id = emailResult.messageId || null;
    await supabaseDbRequest('registration_tasks',
      'id=eq.' + encodeURIComponent(taskId),
      { method: 'PATCH', body: { status: 'waiting_on_gp', metadata: taskMeta, updated_at: new Date().toISOString() } });

    await _logCaseEvent(task.case_id, taskId, 'system', 'SPPA-00 sent to candidate via email', candidateEmail, admin.email);
    sendJson(res, 200, { ok: true });
    return;
  }
```

- [ ] **Step 2: Replace the sppa-pdf preview endpoint**

Find and replace the `// ── Preview signed SPPA-00 PDF ──` block (lines 28677-28691). Replace with:

```javascript
  // ── Preview SPPA-00 PDF (from task_documents) ──
  if (req.method === 'GET' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-pdf')) {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const taskId = pathname.split('/')[5];
    const docRes = await supabaseDbRequest('task_documents',
      'select=attachment_url&task_id=eq.' + encodeURIComponent(taskId) + '&is_current=eq.true&limit=1');
    const doc = docRes.ok && docRes.data && docRes.data[0] ? docRes.data[0] : null;
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

- [ ] **Step 3: Replace the sppa-approve endpoint with sppa-send-to-practice**

Find and replace the `// ── Approve signed SPPA-00 and deliver to My Documents ──` block (lines 28693-28735). Replace with:

```javascript
  // ── Send SPPA-00 to practice contact via Gmail ──
  if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-send-to-practice')) {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const taskId = pathname.split('/')[5];

    const taskRes = await supabaseDbRequest('registration_tasks',
      'select=id,case_id,metadata&id=eq.' + encodeURIComponent(taskId) + '&related_document_key=eq.sppa_00&limit=1');
    if (!taskRes.ok || !taskRes.data || !taskRes.data[0]) { sendJson(res, 404, { error: 'task not found' }); return; }
    const task = taskRes.data[0];
    var taskMeta = task.metadata;
    if (typeof taskMeta === 'string') try { taskMeta = JSON.parse(taskMeta); } catch (e) { taskMeta = {}; }
    if (!taskMeta || taskMeta.sppa_state !== 'gp_returned') { sendJson(res, 400, { error: 'SPPA not in GP returned state' }); return; }

    // Get the current PDF (GP-completed version)
    const docRes = await supabaseDbRequest('task_documents',
      'select=attachment_url&task_id=eq.' + encodeURIComponent(taskId) + '&is_current=eq.true&limit=1');
    const doc = docRes.ok && docRes.data && docRes.data[0] ? docRes.data[0] : null;
    if (!doc || !doc.attachment_url) { sendJson(res, 400, { error: 'No SPPA PDF found' }); return; }

    // Get practice contact email from career state
    const caseRes = await supabaseDbRequest('registration_cases',
      'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    const userId = caseRes.ok && caseRes.data && caseRes.data[0] ? caseRes.data[0].user_id : null;
    if (!userId) { sendJson(res, 404, { error: 'case not found' }); return; }

    const stateRes = await supabaseDbRequest('user_state',
      'select=state&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    var careerState = {};
    if (stateRes.ok && stateRes.data && stateRes.data[0]) {
      var stVal = stateRes.data[0].state;
      if (typeof stVal === 'string') try { careerState = JSON.parse(stVal); } catch (e) {}
      else if (stVal && typeof stVal === 'object') careerState = stVal;
    }
    if (careerState.gp_career_state) {
      careerState = typeof careerState.gp_career_state === 'string' ? JSON.parse(careerState.gp_career_state) : careerState.gp_career_state;
    }
    var secured = careerState.career_secured ? careerState : (Array.isArray(careerState.applications) ? careerState.applications.find(function (a) { return a && a.isPlacementSecured; }) : null);
    var placement = (secured && secured.placement) || secured || {};
    var pc = placement.practiceContact || {};
    var practiceEmail = String(pc.email || '').trim();
    var practiceName = String(pc.name || 'Practice Contact').trim();
    if (!practiceEmail) { sendJson(res, 400, { error: 'practice contact email missing' }); return; }

    // Extract base64
    const commaIdx = doc.attachment_url.indexOf(',');
    const pdfBase64 = doc.attachment_url.substring(commaIdx + 1);

    // Get candidate name for the email
    const profRes = await supabaseDbRequest('user_profiles',
      'select=first_name,last_name&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const prof = (profRes.ok && profRes.data && profRes.data[0]) ? profRes.data[0] : {};
    var candidateName = ('Dr ' + (prof.first_name || '') + ' ' + (prof.last_name || '')).trim();

    const emailResult = await sendGmailEmail({
      from: 'hazel@mygplink.com.au',
      to: practiceEmail,
      subject: 'SPPA-00 Supervised Practice Plan for ' + candidateName + ' — Please Complete and Sign',
      bodyHtml: '<p>Dear ' + practiceName + ',</p>' +
        '<p>Please find attached the Supervised Practice Plan Agreement (SPPA-00) for ' + candidateName + '.</p>' +
        '<p>The candidate has completed their section. Could you please:</p>' +
        '<ol>' +
        '<li>Complete <b>Sections B through H</b> (Supervisor details, practice arrangement, goals)</li>' +
        '<li>Sign <b>Section J</b> (Primary supervisor\'s declaration)</li>' +
        '<li>Have any alternate supervisor(s) sign <b>Section K</b> if applicable</li>' +
        '</ol>' +
        '<p>Once completed, please reply to this email with the signed document attached.</p>' +
        '<p>Kind regards,<br>GP Link Registration Team</p>',
      attachments: [{
        filename: 'SPPA-00.pdf',
        mimeType: 'application/pdf',
        content: pdfBase64
      }]
    });
    if (!emailResult.ok) { sendJson(res, 502, { error: 'Failed to send email: ' + (emailResult.error || '') }); return; }

    taskMeta.sppa_state = 'sent_to_practice';
    taskMeta.sent_to_practice_at = new Date().toISOString();
    taskMeta.sent_to_practice_email = practiceEmail;
    taskMeta.practice_gmail_message_id = emailResult.messageId || null;
    await supabaseDbRequest('registration_tasks',
      'id=eq.' + encodeURIComponent(taskId),
      { method: 'PATCH', body: { status: 'waiting_on_practice', metadata: taskMeta, updated_at: new Date().toISOString() } });

    await _logCaseEvent(task.case_id, taskId, 'system', 'SPPA-00 sent to practice via email', practiceEmail, admin.email);
    sendJson(res, 200, { ok: true });
    return;
  }
```

- [ ] **Step 4: Replace the correction endpoint with Q7 override + submit endpoints**

Find and replace the `// ── Request SPPA-00 correction ──` block (lines 28737-28760+). Replace with:

```javascript
  // ── Override Q7 on SPPA-00 ──
  if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-override-q7')) {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const taskId = pathname.split('/')[5];
    const body = await readJsonBody(req);
    var newIsConflict = !!(body && body.is_conflict);
    var customDetails = (body && body.details) ? String(body.details).trim() : '';

    const taskRes = await supabaseDbRequest('registration_tasks',
      'select=id,case_id,metadata&id=eq.' + encodeURIComponent(taskId) + '&related_document_key=eq.sppa_00&limit=1');
    if (!taskRes.ok || !taskRes.data || !taskRes.data[0]) { sendJson(res, 404, { error: 'task not found' }); return; }
    const task = taskRes.data[0];
    var taskMeta = task.metadata;
    if (typeof taskMeta === 'string') try { taskMeta = JSON.parse(taskMeta); } catch (e) { taskMeta = {}; }
    if (!taskMeta || taskMeta.sppa_state !== 'ready_to_send') { sendJson(res, 400, { error: 'Can only override Q7 before sending' }); return; }

    // Regenerate PDF
    var fillParams = { isConflict: newIsConflict };
    if (customDetails) fillParams.detailsText = customDetails;
    var filledPdfBuffer = await fillSppaQ7(fillParams);

    // Mark old doc as not current, insert new
    await supabaseDbRequest('task_documents',
      'task_id=eq.' + encodeURIComponent(taskId) + '&is_current=eq.true',
      { method: 'PATCH', body: { is_current: false } });
    var pdfDataUrl = 'data:application/pdf;base64,' + filledPdfBuffer.toString('base64');
    await supabaseDbRequest('task_documents', '', {
      method: 'POST',
      body: [{
        task_id: task.id,
        case_id: task.case_id,
        filename: 'SPPA-00.pdf',
        mime_type: 'application/pdf',
        size_bytes: filledPdfBuffer.length,
        version: 2,
        is_current: true,
        uploaded_by: 'admin_q7_override',
        attachment_url: pdfDataUrl
      }]
    });

    // Update metadata
    taskMeta.is_conflict = newIsConflict;
    taskMeta.q7_overridden = true;
    taskMeta.q7_overridden_by = admin.email;
    taskMeta.q7_overridden_at = new Date().toISOString();
    if (customDetails) taskMeta.q7_custom_details = customDetails;
    await supabaseDbRequest('registration_tasks',
      'id=eq.' + encodeURIComponent(taskId),
      { method: 'PATCH', body: { metadata: taskMeta, updated_at: new Date().toISOString() } });

    await _logCaseEvent(task.case_id, taskId, 'system',
      'VA overrode Q7 to ' + (newIsConflict ? 'YES' : 'NO'),
      customDetails || null, admin.email);

    sendJson(res, 200, { ok: true, is_conflict: newIsConflict });
    return;
  }

  // ── Store returned SPPA-00 (from candidate or practice) ──
  if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-store-returned')) {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const taskId = pathname.split('/')[5];
    const body = await readJsonBody(req);
    var returnedFrom = String((body && body.from) || '').toLowerCase();
    var fileDataUrl = String((body && body.file_data_url) || '');
    var fileName = String((body && body.file_name) || 'SPPA-00.pdf');
    if (returnedFrom !== 'candidate' && returnedFrom !== 'practice') { sendJson(res, 400, { error: 'from must be candidate or practice' }); return; }
    if (!fileDataUrl) { sendJson(res, 400, { error: 'file_data_url required' }); return; }

    const taskRes = await supabaseDbRequest('registration_tasks',
      'select=id,case_id,metadata&id=eq.' + encodeURIComponent(taskId) + '&related_document_key=eq.sppa_00&limit=1');
    if (!taskRes.ok || !taskRes.data || !taskRes.data[0]) { sendJson(res, 404, { error: 'task not found' }); return; }
    const task = taskRes.data[0];
    var taskMeta = task.metadata;
    if (typeof taskMeta === 'string') try { taskMeta = JSON.parse(taskMeta); } catch (e) { taskMeta = {}; }

    // Mark old doc as not current, insert new
    await supabaseDbRequest('task_documents',
      'task_id=eq.' + encodeURIComponent(taskId) + '&is_current=eq.true',
      { method: 'PATCH', body: { is_current: false } });

    var commaIdx = fileDataUrl.indexOf(',');
    var mimeMatch = fileDataUrl.substring(0, commaIdx).match(/data:([^;]+)/);
    var mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
    var b64 = fileDataUrl.substring(commaIdx + 1);
    var sizeBytes = Math.ceil(b64.length * 3 / 4);

    await supabaseDbRequest('task_documents', '', {
      method: 'POST',
      body: [{
        task_id: task.id,
        case_id: task.case_id,
        filename: fileName,
        mime_type: mime,
        size_bytes: sizeBytes,
        version: returnedFrom === 'candidate' ? 3 : 4,
        is_current: true,
        uploaded_by: 'admin_manual_' + returnedFrom + '_return',
        attachment_url: fileDataUrl
      }]
    });

    if (returnedFrom === 'candidate') {
      taskMeta.sppa_state = 'gp_returned';
      taskMeta.gp_returned_at = new Date().toISOString();
      await supabaseDbRequest('registration_tasks',
        'id=eq.' + encodeURIComponent(taskId),
        { method: 'PATCH', body: { status: 'in_progress', metadata: taskMeta, updated_at: new Date().toISOString() } });
      await _logCaseEvent(task.case_id, taskId, 'system', 'GP returned partially completed SPPA-00', null, admin.email);
    } else {
      taskMeta.sppa_state = 'practice_returned';
      taskMeta.practice_returned_at = new Date().toISOString();
      await supabaseDbRequest('registration_tasks',
        'id=eq.' + encodeURIComponent(taskId),
        { method: 'PATCH', body: { status: 'in_progress', metadata: taskMeta, updated_at: new Date().toISOString() } });
      await _logCaseEvent(task.case_id, taskId, 'system', 'Practice returned completed SPPA-00', null, admin.email);
    }

    sendJson(res, 200, { ok: true, state: taskMeta.sppa_state });
    return;
  }

  // ── Submit final SPPA-00 — deliver to MyDocuments + complete task ──
  if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-submit')) {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const taskId = pathname.split('/')[5];

    const taskRes = await supabaseDbRequest('registration_tasks',
      'select=id,case_id,metadata&id=eq.' + encodeURIComponent(taskId) + '&related_document_key=eq.sppa_00&limit=1');
    if (!taskRes.ok || !taskRes.data || !taskRes.data[0]) { sendJson(res, 404, { error: 'task not found' }); return; }
    const task = taskRes.data[0];
    var taskMeta = task.metadata;
    if (typeof taskMeta === 'string') try { taskMeta = JSON.parse(taskMeta); } catch (e) { taskMeta = {}; }
    if (!taskMeta || taskMeta.sppa_state !== 'practice_returned') { sendJson(res, 400, { error: 'SPPA not in practice_returned state' }); return; }

    // Get the final PDF
    const docRes = await supabaseDbRequest('task_documents',
      'select=attachment_url&task_id=eq.' + encodeURIComponent(taskId) + '&is_current=eq.true&limit=1');
    const doc = docRes.ok && docRes.data && docRes.data[0] ? docRes.data[0] : null;
    if (!doc || !doc.attachment_url) { sendJson(res, 400, { error: 'No SPPA PDF found' }); return; }

    // Decode PDF buffer
    var cIdx = doc.attachment_url.indexOf(',');
    var pdfB64 = doc.attachment_url.substring(cIdx + 1).replace(/-/g, '+').replace(/_/g, '/');
    while (pdfB64.length % 4 !== 0) pdfB64 += '=';
    var pdfBuffer = Buffer.from(pdfB64, 'base64');

    // Get userId for delivery
    const caseRes = await supabaseDbRequest('registration_cases',
      'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    const userId = caseRes.ok && caseRes.data && caseRes.data[0] ? caseRes.data[0].user_id : null;
    if (!userId) { sendJson(res, 404, { error: 'case not found' }); return; }

    // Deliver final SPPA to MyDocuments + Google Drive
    var delivery = await deliverToMyDocuments(userId, task.case_id, 'sppa_00', 'SPPA-00 Completed.pdf', pdfBuffer, 'application/pdf');

    // Update practice_doc_ops
    try {
      await supabaseDbRequest('practice_doc_ops',
        'case_id=eq.' + encodeURIComponent(task.case_id) + '&document_key=eq.sppa_00',
        { method: 'PATCH', body: { ops_status: 'completed', updated_at: new Date().toISOString() } });
    } catch (e) {}

    // Complete the task
    taskMeta.sppa_state = 'completed';
    taskMeta.completed_at = new Date().toISOString();
    await supabaseDbRequest('registration_tasks',
      'id=eq.' + encodeURIComponent(taskId),
      { method: 'PATCH', body: { status: 'completed', completed_by: admin.email, completed_at: new Date().toISOString(), metadata: taskMeta, updated_at: new Date().toISOString() } });

    await _logCaseEvent(task.case_id, taskId, 'system', 'SPPA-00 approved and delivered to GP MyDocuments', null, admin.email);
    sendJson(res, 200, { ok: true, delivery: delivery });
    return;
  }
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: replace Zoho Sign SPPA-00 endpoints with email-based flow"
```

---

### Task 6: Update admin.html — SPPA-00 task card with 7-state lifecycle

**Files:**
- Modify: `pages/admin.html` — replace `renderSppaTaskCard()` and related functions (around lines 6597-6735)

- [ ] **Step 1: Replace renderSppaTaskCard function**

Find the function `renderSppaTaskCard` (line 6597) and replace it through the end of `sendSppaCorrection` (line 6735) with:

```javascript
  function renderSppaTaskCard(task) {
    var meta = task.metadata || {};
    if (typeof meta === 'string') try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
    var sppaState = meta.sppa_state || '';
    var html = '';

    // STATE 1: LOCKED — waiting for prerequisites
    if (!sppaState) {
      html += '<div class="doc-task-status">';
      html += '<span class="doc-task-badge pending-setup" style="font-size:11px;color:#78716c">Waiting for Supervisor CV and Offer/Contract to be submitted</span>';
      html += '</div>';
      // Show prerequisite checklist
      html += '<div style="margin-top:6px;font-size:11px;color:#78716c">';
      var svDone = _isPrereqDone(task.case_id, 'supervisor_cv');
      var ocDone = _isPrereqDone(task.case_id, 'offer_contract');
      html += (svDone ? '\u2713' : '\u2717') + ' Supervisor CV<br>';
      html += (ocDone ? '\u2713' : '\u2717') + ' Offer / Contract';
      html += '</div>';
      return html;
    }

    // STATE 2: READY TO SEND — AI scan done, conflict alert
    if (sppaState === 'ready_to_send') {
      // Conflict alert banner
      if (meta.is_conflict && meta.confidence !== 'low') {
        html += '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:11px">';
        html += '<b style="color:#b45309">\u26a0 AI detected conflict of interest:</b> Supervisor <b>' + escHtml(meta.supervisor_name || '') + '</b> is the practice owner/director.';
        html += ' Q7 has been marked <b>YES</b> on the SPPA-00.';
        if (meta.reasoning) {
          html += '<details style="margin-top:4px"><summary style="cursor:pointer;color:#92400e">AI reasoning</summary><p style="margin:4px 0 0;color:#78716c">' + escHtml(meta.reasoning) + '</p></details>';
        }
        html += '</div>';
      } else if (!meta.is_conflict && meta.confidence !== 'low') {
        html += '<div style="background:#ecfdf5;border:1px solid #10b981;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:11px">';
        html += '<span style="color:#065f46">\u2713 No conflict of interest detected. Q7 marked <b>NO</b>.</span>';
        html += '</div>';
      } else {
        html += '<div style="background:#fef2f2;border:1px solid #ef4444;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:11px">';
        html += '<b style="color:#dc2626">\u26a0 AI could not determine with confidence. Manual review required.</b>';
        if (meta.reasoning) {
          html += '<details style="margin-top:4px"><summary style="cursor:pointer;color:#991b1b">AI reasoning</summary><p style="margin:4px 0 0;color:#78716c">' + escHtml(meta.reasoning) + '</p></details>';
        }
        html += '</div>';
      }
      // PDF preview + actions
      html += '<div class="sppa-actions">';
      html += '<button class="btn-action review" onclick="openSppaReview(\'' + escAttr(task.id) + '\')">Preview SPPA</button>';
      html += '<button class="btn-action send" onclick="sppaSendToCandidate(\'' + escAttr(task.id) + '\')">Send to Candidate</button>';
      html += '<button class="btn-action correct" onclick="sppaOverrideQ7(\'' + escAttr(task.id) + '\',' + (meta.is_conflict ? 'true' : 'false') + ')">Override Q7</button>';
      html += '</div>';
      if (meta.q7_overridden) {
        html += '<div style="font-size:10px;color:#78716c;margin-top:4px">Q7 overridden by ' + escHtml(meta.q7_overridden_by || '') + '</div>';
      }
      return html;
    }

    // STATE 3: SENT TO CANDIDATE
    if (sppaState === 'sent_to_candidate') {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">';
      html += '<span class="sppa-chip sent">Sent to GP \u2014 awaiting return</span>';
      if (meta.sent_to_candidate_at) {
        var days = Math.floor((Date.now() - new Date(meta.sent_to_candidate_at).getTime()) / 86400000);
        html += '<span class="sppa-days">' + days + ' day' + (days === 1 ? '' : 's') + '</span>';
      }
      html += '</div>';
      html += '<div class="sppa-actions">';
      html += '<button class="btn-action review" onclick="openSppaReview(\'' + escAttr(task.id) + '\')">Preview SPPA</button>';
      html += '<button class="btn-action send" onclick="sppaMarkReturned(\'' + escAttr(task.id) + '\',\'candidate\')">Mark GP Returned</button>';
      html += '</div>';
      return html;
    }

    // STATE 4: GP RETURNED — waiting on practice
    if (sppaState === 'gp_returned') {
      html += '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:11px">';
      html += '<span style="color:#b45309">Filled by GP, waiting on practice</span>';
      html += '</div>';
      html += '<div class="sppa-actions">';
      html += '<button class="btn-action review" onclick="openSppaReview(\'' + escAttr(task.id) + '\')">Preview SPPA</button>';
      html += '<button class="btn-action send" onclick="sppaSendToPractice(\'' + escAttr(task.id) + '\')">Send to Practice</button>';
      html += '</div>';
      return html;
    }

    // STATE 5: SENT TO PRACTICE
    if (sppaState === 'sent_to_practice') {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">';
      html += '<span class="sppa-chip sent">Sent to Practice \u2014 awaiting return</span>';
      if (meta.sent_to_practice_at) {
        var days = Math.floor((Date.now() - new Date(meta.sent_to_practice_at).getTime()) / 86400000);
        html += '<span class="sppa-days">' + days + ' day' + (days === 1 ? '' : 's') + '</span>';
      }
      html += '</div>';
      html += '<div class="sppa-actions">';
      html += '<button class="btn-action review" onclick="openSppaReview(\'' + escAttr(task.id) + '\')">Preview SPPA</button>';
      html += '<button class="btn-action send" onclick="sppaMarkReturned(\'' + escAttr(task.id) + '\',\'practice\')">Mark Practice Returned</button>';
      html += '</div>';
      return html;
    }

    // STATE 6: PRACTICE RETURNED — VA review
    if (sppaState === 'practice_returned') {
      html += '<div style="background:#eff6ff;border:1px solid #3b82f6;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:11px">';
      html += '<span style="color:#1d4ed8">Completed SPPA-00 returned by practice \u2014 ready for final review</span>';
      html += '</div>';
      html += '<div class="sppa-actions">';
      html += '<button class="btn-action review" onclick="openSppaReview(\'' + escAttr(task.id) + '\')">Review SPPA</button>';
      html += '<button class="btn-action approve" onclick="sppaSubmitFinal(\'' + escAttr(task.id) + '\')">Submit \u2014 Deliver to GP</button>';
      html += '</div>';
      return html;
    }

    // STATE 7: COMPLETED
    if (sppaState === 'completed') {
      html += '<div class="doc-task-status"><span class="doc-task-badge completed">\u2713 SPPA-00 Completed</span></div>';
      return html;
    }

    // Fallback
    html += '<div class="doc-task-status"><span class="doc-task-badge">' + escHtml(sppaState) + '</span></div>';
    return html;
  }
```

- [ ] **Step 2: Add the prerequisite check helper**

Add just before `renderSppaTaskCard`:

```javascript
  // Check if a prerequisite doc task is complete for a case — uses cached task data from loadAll
  function _isPrereqDone(caseId, docKey) {
    if (!window._allTasks || !Array.isArray(window._allTasks)) return false;
    return window._allTasks.some(function (t) {
      return t.case_id === caseId && t.related_document_key === docKey && t.status === 'completed';
    });
  }
```

- [ ] **Step 3: Replace the SPPA action functions**

Replace the old `sendSppa`, `resendSppa`, `updateSppaRecipient`, `openSppaReview`, `closeSppaReview`, `approveSppa`, `openCorrectionModal`, `closeCorrectionModal`, `sendSppaCorrection` functions with:

```javascript
  async function sppaSendToCandidate(taskId) {
    if (!confirm('Send SPPA-00 to the GP candidate via email?')) return;
    try {
      var r = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-send-to-candidate', { method: 'POST', credentials: 'include' });
      var d = await r.json().catch(function () { return {}; });
      if (d && d.ok) { toast('SPPA-00 sent to candidate'); await loadAll(true); }
      else { toast((d && d.error) || 'Failed to send', 'red'); }
    } catch (err) { toast('Network error', 'red'); }
  }

  async function sppaSendToPractice(taskId) {
    if (!confirm('Send SPPA-00 to the practice contact via email?')) return;
    try {
      var r = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-send-to-practice', { method: 'POST', credentials: 'include' });
      var d = await r.json().catch(function () { return {}; });
      if (d && d.ok) { toast('SPPA-00 sent to practice'); await loadAll(true); }
      else { toast((d && d.error) || 'Failed to send', 'red'); }
    } catch (err) { toast('Network error', 'red'); }
  }

  function sppaOverrideQ7(taskId, currentIsConflict) {
    var newVal = !currentIsConflict;
    var customDetails = '';
    if (newVal) {
      customDetails = prompt('Enter conflict details text (or leave blank for default):') || '';
    }
    if (!confirm('Override Q7 to ' + (newVal ? 'YES (conflict)' : 'NO (no conflict)') + '?')) return;
    fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-override-q7', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_conflict: newVal, details: customDetails })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) { toast('Q7 overridden to ' + (newVal ? 'YES' : 'NO')); loadAll(true); }
      else { toast((d && d.error) || 'Override failed', 'red'); }
    }).catch(function () { toast('Network error', 'red'); });
  }

  async function sppaMarkReturned(taskId, from) {
    // Open file picker for the returned PDF
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,application/pdf';
    input.onchange = async function () {
      var file = input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = async function () {
        try {
          var r = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-store-returned', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: from, file_data_url: reader.result, file_name: file.name })
          });
          var d = await r.json().catch(function () { return {}; });
          if (d && d.ok) { toast('Returned SPPA stored (' + from + ')'); await loadAll(true); }
          else { toast((d && d.error) || 'Failed to store', 'red'); }
        } catch (err) { toast('Network error', 'red'); }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  async function sppaSubmitFinal(taskId) {
    if (!confirm('Submit final SPPA-00 and deliver to the GP?')) return;
    try {
      var r = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-submit', { method: 'POST', credentials: 'include' });
      var d = await r.json().catch(function () { return {}; });
      if (d && d.ok) { toast('SPPA-00 submitted and delivered to GP'); await loadAll(true); }
      else { toast((d && d.error) || 'Failed to submit', 'red'); }
    } catch (err) { toast('Network error', 'red'); }
  }

  // Keep openSppaReview and closeSppaReview as-is (they work with the new PDF preview endpoint)
```

Note: Keep the existing `openSppaReview()` and `closeSppaReview()` functions — they already work correctly since the `/sppa-pdf` endpoint was updated to serve from task_documents.

- [ ] **Step 4: Update the SPPA review panel approve button**

In the HTML markup for the SPPA review panel (around line 1326), change the approve button:

Find:
```html
<button class="btn primary" id="sppaApproveBtn" onclick="approveSppa()">Approve &amp; Deliver</button>
```

Replace with:
```html
<button class="btn primary" id="sppaApproveBtn" onclick="closeSppaReview()">Close</button>
```

The approve/deliver action now happens from the task card buttons directly, not from the review panel.

- [ ] **Step 5: Update window exports**

Find the window exports block (around line 7456) and replace the SPPA-related exports:

Find:
```javascript
  window.sendSppa = sendSppa;
  window.resendSppa = resendSppa;
```
through:
```javascript
  window.sendSppaCorrection = sendSppaCorrection;
```

Replace with:
```javascript
  window.sppaSendToCandidate = sppaSendToCandidate;
  window.sppaSendToPractice = sppaSendToPractice;
  window.sppaOverrideQ7 = sppaOverrideQ7;
  window.sppaMarkReturned = sppaMarkReturned;
  window.sppaSubmitFinal = sppaSubmitFinal;
```

Keep `window.openSppaReview` and `window.closeSppaReview`.

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html
git commit -m "feat: update admin SPPA-00 task card with 7-state email-based lifecycle"
```

---

### Task 7: Extend email triage for AHPRA email pipeline

**Files:**
- Modify: `lib/email-triage.js` — add AHPRA-specific detection and classification

- [ ] **Step 1: Add AHPRA classification constants and system prompt**

At the top of `lib/email-triage.js`, after the existing `VALID_URGENCY` line (line 4), add:

```javascript
var AHPRA_CATEGORIES = new Set(['conflict_followup', 'document_request', 'information_request', 'application_update', 'other']);

var AHPRA_TRIAGE_SYSTEM_PROMPT = [
  'You classify inbound emails from AHPRA (Australian Health Practitioner Regulation Agency) officers.',
  'You receive a list of GP candidates and one inbound email from an @ahpra.gov.au address.',
  'Your task:',
  '1. Match the email to a specific GP candidate based on the email content (name, registration number, application reference). Do NOT match based on the officer — one officer can handle many GPs.',
  '2. Classify what the officer is requesting.',
  '',
  'Return JSON:',
  '{',
  '  "matched_gp_user_id": string or null,',
  '  "officer_name": string,',
  '  "officer_email": string,',
  '  "confidence": number in [0,1],',
  '  "category": "conflict_followup" | "document_request" | "information_request" | "application_update" | "other",',
  '  "summary": string (one sentence describing what the officer wants),',
  '  "requested_documents": [string] (list of document names if category is document_request, else empty array),',
  '  "needs_triage": boolean',
  '}',
  '',
  'Category guide:',
  '- conflict_followup: officer is asking about conflicts of interest, supervisor-owner relationships',
  '- document_request: officer is requesting specific documents be provided',
  '- information_request: officer is asking questions about the application or candidate',
  '- application_update: officer is providing a status update, approval, or feedback',
  '- other: none of the above',
  '',
  'Set needs_triage=true when confidence < 0.7 or when the email cannot be matched to a GP.'
].join('\n');
```

- [ ] **Step 2: Add AHPRA triage function**

After the existing `triageEmailWithSonnet` function (after line 90), add:

```javascript
function buildAhpraTriagePrompt(email, gpCandidates) {
  var emailSummary = {
    from: email.sender,
    subject: email.subject,
    date: email.date,
    body_snippet: String(email.bodyText || email.body || '').slice(0, 6000)
  };
  return 'GP_CANDIDATES:\n' + JSON.stringify(gpCandidates || [], null, 2) + '\n\nAHPRA_EMAIL:\n' + JSON.stringify(emailSummary, null, 2) + '\n\nReturn JSON only.';
}

function parseAhpraTriageResponse(text) {
  var defaults = {
    matched_gp_user_id: null,
    officer_name: '',
    officer_email: '',
    confidence: 0,
    category: 'other',
    summary: '',
    requested_documents: [],
    needs_triage: true
  };
  try {
    var start = String(text || '').indexOf('{');
    var end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    var parsed = JSON.parse(String(text).slice(start, end + 1));
    var confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    var category = AHPRA_CATEGORIES.has(parsed.category) ? parsed.category : 'other';
    var matchedUserId = parsed.matched_gp_user_id ? String(parsed.matched_gp_user_id) : null;
    var needsTriage = (confidence < 0.7) || !!parsed.needs_triage || !matchedUserId;
    return {
      matched_gp_user_id: matchedUserId,
      officer_name: String(parsed.officer_name || '').trim(),
      officer_email: String(parsed.officer_email || '').trim(),
      confidence: confidence,
      category: category,
      summary: String(parsed.summary || '').trim(),
      requested_documents: Array.isArray(parsed.requested_documents) ? parsed.requested_documents.map(String) : [],
      needs_triage: needsTriage
    };
  } catch (e) {
    return defaults;
  }
}

async function triageAhpraEmail(email, gpCandidates, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Object.assign(parseAhpraTriageResponse(''), { _error: 'no_api_key' });
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 60000);
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 800,
        system: [{ type: 'text', text: AHPRA_TRIAGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildAhpraTriagePrompt(email, gpCandidates) }]
      })
    });
    if (!resp.ok) return Object.assign(parseAhpraTriageResponse(''), { _error: 'api_error_' + resp.status });
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var parsed = parseAhpraTriageResponse(text);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return Object.assign(parseAhpraTriageResponse(''), { _error: 'fetch_error: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }
}

function isAhpraEmail(senderEmail) {
  return /@ahpra\.gov\.au$/i.test(String(senderEmail || '').trim());
}
```

- [ ] **Step 3: Update the module.exports**

Replace the existing `module.exports` line at the bottom of the file:

```javascript
module.exports = {
  triageEmailWithSonnet, parseTriageResponse, buildTriagePrompt, TRIAGE_SYSTEM_PROMPT,
  triageAhpraEmail, parseAhpraTriageResponse, buildAhpraTriagePrompt, isAhpraEmail, AHPRA_TRIAGE_SYSTEM_PROMPT
};
```

- [ ] **Step 4: Commit**

```bash
git add lib/email-triage.js
git commit -m "feat: add AHPRA email triage pipeline (Opus classification)"
```

---

### Task 8: Wire AHPRA email detection into Gmail webhook handler in server.js

**Files:**
- Modify: `server.js` — in the Gmail notification processing flow, add AHPRA email detection and task creation

- [ ] **Step 1: Add the require for AHPRA triage functions**

Find the existing require for `email-triage.js` in `server.js`. It will look like:

```javascript
const { triageEmailWithSonnet } = require('./lib/email-triage.js');
```

Replace with:

```javascript
const { triageEmailWithSonnet, triageAhpraEmail, isAhpraEmail } = require('./lib/email-triage.js');
```

- [ ] **Step 2: Add the AHPRA email handler function**

Add after `_maybeRunSppaConflictScan` (added in Task 4):

```javascript
/**
 * Process an inbound AHPRA officer email: classify it and create an admin task.
 * Called from the Gmail webhook pipeline when sender matches @ahpra.gov.au.
 */
async function _processAhpraEmail(emailMeta) {
  try {
    // 1. Get all placed GP candidates for matching context
    var gpRes = await supabaseDbRequest('registration_cases',
      'select=id,user_id,stage,status&status=in.(active,in_progress)&stage=in.(ahpra,career,pbs,commencement)&limit=200');
    var gpCandidates = [];
    if (gpRes.ok && Array.isArray(gpRes.data)) {
      for (var c of gpRes.data) {
        var profRes = await supabaseDbRequest('user_profiles',
          'select=first_name,last_name,email&user_id=eq.' + encodeURIComponent(c.user_id) + '&limit=1');
        var prof = (profRes.ok && profRes.data && profRes.data[0]) ? profRes.data[0] : {};
        gpCandidates.push({
          user_id: c.user_id,
          case_id: c.id,
          name: ((prof.first_name || '') + ' ' + (prof.last_name || '')).trim(),
          email: prof.email || '',
          stage: c.stage
        });
      }
    }

    // 2. Classify with Opus
    var triage = await triageAhpraEmail(emailMeta, gpCandidates);
    console.log('[AHPRA Email]', JSON.stringify({ category: triage.category, matched: triage.matched_gp_user_id, confidence: triage.confidence, summary: triage.summary }));

    if (!triage.matched_gp_user_id) {
      console.log('[AHPRA Email] Could not match to a GP — creating unmatched triage task');
      // Create a generic triage task (no GP matched)
      await supabaseDbRequest('registration_tasks', '', {
        method: 'POST',
        body: [{
          task_type: 'ahpra_correspondence',
          title: 'AHPRA email — unmatched GP',
          priority: 'high',
          status: 'open',
          source_trigger: 'ahpra_email',
          related_stage: 'ahpra',
          metadata: {
            ahpra_officer_name: triage.officer_name,
            ahpra_officer_email: triage.officer_email || emailMeta.sender,
            category: triage.category,
            summary: triage.summary,
            email_subject: emailMeta.subject,
            email_date: emailMeta.date,
            needs_triage: true
          }
        }]
      });
      return;
    }

    // 3. Find the GP's case
    var matchedGp = gpCandidates.find(function (g) { return g.user_id === triage.matched_gp_user_id; });
    var caseId = matchedGp ? matchedGp.case_id : null;
    if (!caseId) return;

    // 4. Store AHPRA officer on the case (convenience reference)
    if (triage.officer_email) {
      try {
        var caseMetaRes = await supabaseDbRequest('registration_cases',
          'select=metadata&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
        var caseMeta = (caseMetaRes.ok && caseMetaRes.data && caseMetaRes.data[0]) ? caseMetaRes.data[0].metadata : {};
        if (typeof caseMeta === 'string') try { caseMeta = JSON.parse(caseMeta); } catch (e) { caseMeta = {}; }
        if (!caseMeta) caseMeta = {};
        caseMeta.ahpra_officer_name = triage.officer_name || caseMeta.ahpra_officer_name;
        caseMeta.ahpra_officer_email = triage.officer_email || caseMeta.ahpra_officer_email;
        await supabaseDbRequest('registration_cases',
          'id=eq.' + encodeURIComponent(caseId),
          { method: 'PATCH', body: { metadata: caseMeta } });
      } catch (e) {
        console.error('[AHPRA Email] case metadata update error:', e.message);
      }
    }

    // 5. Create the appropriate task based on category
    var taskTitle = '';
    var taskDetail = '';
    var taskMeta = {
      ahpra_officer_name: triage.officer_name,
      ahpra_officer_email: triage.officer_email || emailMeta.sender,
      category: triage.category,
      summary: triage.summary,
      email_subject: emailMeta.subject,
      email_date: emailMeta.date
    };

    if (triage.category === 'conflict_followup') {
      // Check if this GP has is_conflict=true on their SPPA-00
      var sppaRes = await supabaseDbRequest('registration_tasks',
        'select=metadata&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.sppa_00&task_type=eq.practice_pack_child&limit=1');
      var sppaMeta = (sppaRes.ok && sppaRes.data && sppaRes.data[0]) ? sppaRes.data[0].metadata : {};
      if (typeof sppaMeta === 'string') try { sppaMeta = JSON.parse(sppaMeta); } catch (e) { sppaMeta = {}; }

      taskTitle = 'AHPRA conflict of interest follow-up — ' + (matchedGp.name || 'GP');
      taskDetail = 'Email the practice contact asking them to email ' + (triage.officer_email || emailMeta.sender) +
        ' explaining how potential future conflicts of interest will be managed (supervisor is also practice owner/director).';
      taskMeta.requires_practice_contact_email = true;
    } else if (triage.category === 'document_request') {
      taskTitle = 'AHPRA document request — ' + (matchedGp.name || 'GP');
      taskDetail = triage.summary + (triage.requested_documents.length ? '\n\nRequested: ' + triage.requested_documents.join(', ') : '');
      taskMeta.requested_documents = triage.requested_documents;
    } else if (triage.category === 'information_request') {
      taskTitle = 'AHPRA information request — ' + (matchedGp.name || 'GP');
      taskDetail = triage.summary;
    } else if (triage.category === 'application_update') {
      taskTitle = 'AHPRA application update — ' + (matchedGp.name || 'GP');
      taskDetail = triage.summary;
    } else {
      taskTitle = 'AHPRA correspondence — ' + (matchedGp.name || 'GP');
      taskDetail = triage.summary;
    }

    await supabaseDbRequest('registration_tasks', '', {
      method: 'POST',
      body: [{
        case_id: caseId,
        task_type: 'ahpra_correspondence',
        title: taskTitle,
        detail: taskDetail,
        priority: triage.category === 'conflict_followup' ? 'high' : 'normal',
        status: 'open',
        source_trigger: 'ahpra_email',
        related_stage: 'ahpra',
        metadata: taskMeta
      }]
    });

    await _logCaseEvent(caseId, null, 'system',
      'AHPRA email received — ' + triage.category,
      triage.summary,
      'ahpra_email_pipeline',
      { officer_email: triage.officer_email || emailMeta.sender });

    console.log('[AHPRA Email] Created task: ' + taskTitle);
  } catch (err) {
    console.error('[AHPRA Email] processing error:', err.message);
  }
}
```

- [ ] **Step 3: Wire AHPRA detection into the Gmail webhook pipeline**

Find the Gmail notification processing flow in `server.js`. Look for where emails are routed to the triage pipeline — there will be a section after attachment processing where non-attachment emails go to `triageEmailWithSonnet()`. This is around the `processGmailNotification` function.

Before the existing general triage call, add an AHPRA check:

```javascript
    // AHPRA officer email pipeline — intercept before general triage
    if (isAhpraEmail(emailMeta.sender)) {
      console.log('[Gmail] AHPRA email detected from:', emailMeta.sender);
      _processAhpraEmail(emailMeta).catch(function (err) {
        console.error('[Gmail] AHPRA email processing error:', err.message);
      });
      // Still continue to general triage for visibility in Incoming Questions
    }
```

The exact insertion point depends on where `emailMeta.sender` is available in the pipeline. Search for the line that calls `triageEmailWithSonnet` in the Gmail webhook flow and add the AHPRA check immediately before it.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: wire AHPRA email detection into Gmail webhook pipeline"
```

---

### Task 9: Final integration verification

**Files:** None (verification only)

- [ ] **Step 1: Verify server starts without errors**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)" && npm start
```

Expected: Server starts on port 3000 with no require/syntax errors. Check console output for any `Error` or `Cannot find module` messages.

- [ ] **Step 2: Verify pdf-lib can load the template**

```bash
node -e "
const { fillSppaQ7 } = require('./lib/sppa-pdf-fill');
fillSppaQ7({ isConflict: true }).then(buf => console.log('PDF filled OK:', buf.length, 'bytes')).catch(err => console.error('ERROR:', err.message));
"
```

Expected: `PDF filled OK: XXXXX bytes`

- [ ] **Step 3: Verify the conflict scan module loads**

```bash
node -e "
const { scanForConflict } = require('./lib/sppa-conflict-scan');
console.log('Conflict scan module loaded OK');
console.log('Function type:', typeof scanForConflict);
"
```

Expected: `Conflict scan module loaded OK` and `Function type: function`

- [ ] **Step 4: Verify email triage module loads with AHPRA functions**

```bash
node -e "
const { triageAhpraEmail, isAhpraEmail } = require('./lib/email-triage');
console.log('AHPRA triage loaded OK');
console.log('isAhpra test:', isAhpraEmail('john@ahpra.gov.au'), isAhpraEmail('john@gmail.com'));
"
```

Expected: `AHPRA triage loaded OK` and `isAhpra test: true false`

- [ ] **Step 5: Push all commits**

```bash
git push
```

- [ ] **Step 6: Deploy via Vercel CLI**

```bash
vercel --prod
```

Verify the deployment succeeds without build errors.
