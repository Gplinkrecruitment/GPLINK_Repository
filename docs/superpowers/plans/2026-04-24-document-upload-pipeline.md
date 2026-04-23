# Document Upload Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every GP document upload goes through AI verification, auto-approves/rejects based on confidence, uploads approved docs to Google Drive, and creates VA tasks for uncertain documents.

**Architecture:** A single `processDocumentUpload()` middleware function in server.js is called by all upload endpoints after saving to Supabase Storage. It runs in the background (the upload returns 200 immediately with `status: "processing"`), classifies the document via Claude AI, and routes to auto-approve, VA review, or auto-reject based on confidence thresholds. A new `lib/document-pipeline.js` module holds the sanitisation, classification, and pipeline logic. A new `lib/file-sanitise.js` module holds file validation and security checks.

**Tech Stack:** Claude Sonnet 4.6 (AI classification), mammoth (DOCX text extraction), googleapis (Google Drive upload/delete), Supabase (storage + database)

**Spec:** `docs/superpowers/specs/2026-04-24-document-upload-pipeline-design.md`

---

### Task 1: Database Migration — Add Columns to user_documents

**Files:**
- Create: `supabase/migrations/20260424010000_document_pipeline_columns.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Add document pipeline columns to user_documents
ALTER TABLE public.user_documents
  ADD COLUMN IF NOT EXISTS google_drive_file_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rejection_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ai_classification_confidence integer,
  ADD COLUMN IF NOT EXISTS ai_classification_result text NOT NULL DEFAULT '';
```

- [ ] **Step 2: Run migration against Supabase**

Run the SQL in the Supabase SQL Editor at `https://supabase.com/dashboard/project/rqrqcfxalkvzwbedvsjs/sql/new`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260424010000_document_pipeline_columns.sql
git commit -m "feat: add google_drive_file_id, rejection_reason, ai columns to user_documents"
```

---

### Task 2: Install mammoth dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install mammoth**

```bash
npm install mammoth
```

- [ ] **Step 2: Verify it installed**

```bash
node -e "require('mammoth'); console.log('mammoth OK')"
```

Expected: `mammoth OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add mammoth for DOCX text extraction"
```

---

### Task 3: File Sanitisation Module

**Files:**
- Create: `lib/file-sanitise.js`
- Create: `tests/file-sanitise.test.js`

- [ ] **Step 1: Write tests for file sanitisation**

```javascript
// tests/file-sanitise.test.js
const { describe, it, expect } = require('vitest');
const {
  sanitiseFileName,
  validateMimeType,
  validateMagicBytes,
  validatePdfSafety,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES
} = require('../lib/file-sanitise.js');

describe('sanitiseFileName', () => {
  it('strips path traversal', () => {
    expect(sanitiseFileName('../../../etc/passwd')).toBe('etc_passwd');
  });
  it('strips null bytes', () => {
    expect(sanitiseFileName('file\x00.pdf')).toBe('file.pdf');
  });
  it('strips control characters', () => {
    expect(sanitiseFileName('file\x01\x02.pdf')).toBe('file.pdf');
  });
  it('limits to 255 characters', () => {
    const long = 'a'.repeat(300) + '.pdf';
    expect(sanitiseFileName(long).length).toBeLessThanOrEqual(255);
  });
  it('preserves valid names', () => {
    expect(sanitiseFileName('My-Document_2026.pdf')).toBe('My-Document_2026.pdf');
  });
  it('returns fallback for empty input', () => {
    expect(sanitiseFileName('')).toBe('document');
  });
});

describe('validateMimeType', () => {
  it('accepts PDF', () => {
    expect(validateMimeType('application/pdf')).toBe(true);
  });
  it('accepts JPEG', () => {
    expect(validateMimeType('image/jpeg')).toBe(true);
  });
  it('accepts PNG', () => {
    expect(validateMimeType('image/png')).toBe(true);
  });
  it('accepts WebP', () => {
    expect(validateMimeType('image/webp')).toBe(true);
  });
  it('accepts HEIC', () => {
    expect(validateMimeType('image/heic')).toBe(true);
  });
  it('accepts DOC', () => {
    expect(validateMimeType('application/msword')).toBe(true);
  });
  it('accepts DOCX', () => {
    expect(validateMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });
  it('rejects executable', () => {
    expect(validateMimeType('application/x-executable')).toBe(false);
  });
  it('rejects HTML', () => {
    expect(validateMimeType('text/html')).toBe(false);
  });
  it('rejects empty', () => {
    expect(validateMimeType('')).toBe(false);
  });
});

describe('validateMagicBytes', () => {
  it('validates PDF magic bytes', () => {
    const buf = Buffer.from('%PDF-1.4 rest of content');
    expect(validateMagicBytes(buf, 'application/pdf')).toBe(true);
  });
  it('validates JPEG magic bytes', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
    expect(validateMagicBytes(buf, 'image/jpeg')).toBe(true);
  });
  it('validates PNG magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(validateMagicBytes(buf, 'image/png')).toBe(true);
  });
  it('validates DOCX magic bytes (ZIP header)', () => {
    const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00]);
    expect(validateMagicBytes(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });
  it('rejects mismatched bytes', () => {
    const buf = Buffer.from('not a pdf');
    expect(validateMagicBytes(buf, 'application/pdf')).toBe(false);
  });
  it('skips validation for HEIC (complex container)', () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x20]);
    expect(validateMagicBytes(buf, 'image/heic')).toBe(true);
  });
});

describe('validatePdfSafety', () => {
  it('accepts safe PDF', () => {
    const buf = Buffer.from('%PDF-1.4\nsome content\n%%EOF');
    expect(validatePdfSafety(buf)).toEqual({ safe: true });
  });
  it('rejects PDF with /Launch', () => {
    const buf = Buffer.from('%PDF-1.4\n/Launch /Action\n%%EOF');
    expect(validatePdfSafety(buf).safe).toBe(false);
  });
  it('rejects PDF with /JavaScript', () => {
    const buf = Buffer.from('%PDF-1.4\n/JavaScript (alert)\n%%EOF');
    expect(validatePdfSafety(buf).safe).toBe(false);
  });
  it('rejects PDF with /OpenAction', () => {
    const buf = Buffer.from('%PDF-1.4\n/OpenAction /URI\n%%EOF');
    expect(validatePdfSafety(buf).safe).toBe(false);
  });
  it('rejects PDF with /AA', () => {
    const buf = Buffer.from('%PDF-1.4\n/AA << /O >>\n%%EOF');
    expect(validatePdfSafety(buf).safe).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/file-sanitise.test.js
```

Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// lib/file-sanitise.js
'use strict';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const MAGIC_BYTES = {
  'application/pdf': { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 },           // %PDF
  'image/jpeg': { bytes: [0xFF, 0xD8, 0xFF], offset: 0 },
  'image/png': { bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0 },
  'image/webp': { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },                // RIFF
  'application/msword': { bytes: [0xD0, 0xCF, 0x11, 0xE0], offset: 0 },        // OLE
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    { bytes: [0x50, 0x4B, 0x03, 0x04], offset: 0 }                             // ZIP (PK)
};

const PDF_DANGEROUS_PATTERNS = [
  /\/JavaScript\b/i,
  /\/Launch\b/i,
  /\/OpenAction\b/i,
  /\/AA\s*<</i
];

function sanitiseFileName(name) {
  if (!name || typeof name !== 'string') return 'document';
  let s = name;
  s = s.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
  s = s.replace(/[\x00-\x1F\x7F]/g, '');
  s = s.replace(/[/\\:*?"<>|]/g, '_');
  s = s.trim();
  if (!s) return 'document';
  if (s.length > 255) {
    const ext = s.lastIndexOf('.') > 200 ? '' : s.slice(s.lastIndexOf('.'));
    s = s.slice(0, 255 - ext.length) + ext;
  }
  return s;
}

function validateMimeType(mimeType) {
  return ALLOWED_MIME_TYPES.has(String(mimeType || '').trim().toLowerCase());
}

function validateMagicBytes(buffer, mimeType) {
  if (!buffer || buffer.length < 4) return false;
  const mime = String(mimeType || '').trim().toLowerCase();
  // HEIC uses ISOBMFF container — magic byte check is complex, skip
  if (mime === 'image/heic') return true;
  const spec = MAGIC_BYTES[mime];
  if (!spec) return true; // unknown type, skip check
  for (let i = 0; i < spec.bytes.length; i++) {
    if (buffer[spec.offset + i] !== spec.bytes[i]) return false;
  }
  return true;
}

function validatePdfSafety(buffer) {
  if (!buffer || buffer.length === 0) return { safe: false, reason: 'Empty file.' };
  const content = buffer.toString('latin1');
  for (const pattern of PDF_DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      return { safe: false, reason: 'PDF contains potentially dangerous embedded actions.' };
    }
  }
  return { safe: true };
}

function validateFileUpload(buffer, mimeType, fileName) {
  const errors = [];
  const cleanMime = String(mimeType || '').trim().toLowerCase();
  const cleanName = sanitiseFileName(fileName);

  if (!buffer || buffer.length === 0) {
    errors.push('File is empty.');
  } else if (buffer.length > MAX_FILE_SIZE_BYTES) {
    errors.push('File exceeds 10MB limit.');
  }

  if (!validateMimeType(cleanMime)) {
    errors.push('File type not allowed. Accepted: PDF, JPEG, PNG, WebP, HEIC, DOC, DOCX.');
  }

  if (buffer && buffer.length >= 4 && !validateMagicBytes(buffer, cleanMime)) {
    errors.push('File content does not match its declared type.');
  }

  if (cleanMime === 'application/pdf' && buffer && buffer.length > 0) {
    const pdfCheck = validatePdfSafety(buffer);
    if (!pdfCheck.safe) errors.push(pdfCheck.reason);
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitisedFileName: cleanName,
    mimeType: cleanMime
  };
}

module.exports = {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_MIME_TYPES,
  sanitiseFileName,
  validateMimeType,
  validateMagicBytes,
  validatePdfSafety,
  validateFileUpload
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/file-sanitise.test.js
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/file-sanitise.js tests/file-sanitise.test.js
git commit -m "feat: add file sanitisation module with magic byte and PDF safety checks"
```

---

### Task 4: Document Pipeline Module

**Files:**
- Create: `lib/document-pipeline.js`
- Create: `tests/document-pipeline.test.js`

- [ ] **Step 1: Write tests for the pipeline helpers**

```javascript
// tests/document-pipeline.test.js
const { describe, it, expect } = require('vitest');
const {
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  isDocMime
} = require('../lib/document-pipeline.js');

describe('classifyConfidenceAction', () => {
  it('returns auto_approve for >= 70', () => {
    expect(classifyConfidenceAction(70)).toBe('auto_approve');
    expect(classifyConfidenceAction(100)).toBe('auto_approve');
  });
  it('returns va_review for 40-69', () => {
    expect(classifyConfidenceAction(40)).toBe('va_review');
    expect(classifyConfidenceAction(69)).toBe('va_review');
  });
  it('returns auto_reject for < 40', () => {
    expect(classifyConfidenceAction(0)).toBe('auto_reject');
    expect(classifyConfidenceAction(39)).toBe('auto_reject');
  });
  it('returns va_review for null/undefined', () => {
    expect(classifyConfidenceAction(null)).toBe('va_review');
    expect(classifyConfidenceAction(undefined)).toBe('va_review');
  });
});

describe('buildRejectionMessage', () => {
  it('builds specific message', () => {
    const msg = buildRejectionMessage('passport', 'MRCGP Certificate');
    expect(msg).toContain('passport');
    expect(msg).toContain('MRCGP Certificate');
  });
  it('handles missing identifiedAs', () => {
    const msg = buildRejectionMessage('', 'MRCGP Certificate');
    expect(msg).toContain('MRCGP Certificate');
    expect(msg).toContain('does not appear to match');
  });
});

describe('isVisuallyClassifiable', () => {
  it('returns true for PDF', () => {
    expect(isVisuallyClassifiable('application/pdf')).toBe(true);
  });
  it('returns true for JPEG', () => {
    expect(isVisuallyClassifiable('image/jpeg')).toBe(true);
  });
  it('returns false for DOCX', () => {
    expect(isVisuallyClassifiable('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
  });
  it('returns false for DOC', () => {
    expect(isVisuallyClassifiable('application/msword')).toBe(false);
  });
});

describe('isDocxMime / isDocMime', () => {
  it('detects DOCX', () => {
    expect(isDocxMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });
  it('detects DOC', () => {
    expect(isDocMime('application/msword')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/document-pipeline.test.js
```

Expected: FAIL — module not found

- [ ] **Step 3: Write the pipeline module**

```javascript
// lib/document-pipeline.js
'use strict';

const CONFIDENCE_AUTO_APPROVE = 70;
const CONFIDENCE_VA_REVIEW = 40;

function classifyConfidenceAction(confidence) {
  if (confidence === null || confidence === undefined) return 'va_review';
  const n = Number(confidence);
  if (!Number.isFinite(n)) return 'va_review';
  if (n >= CONFIDENCE_AUTO_APPROVE) return 'auto_approve';
  if (n >= CONFIDENCE_VA_REVIEW) return 'va_review';
  return 'auto_reject';
}

function buildRejectionMessage(identifiedAs, expectedLabel) {
  const expected = String(expectedLabel || 'the expected document').trim();
  const identified = String(identifiedAs || '').trim();
  if (identified) {
    return 'This appears to be a ' + identified + ' but we expected a ' + expected + '. Please re-upload the correct document.';
  }
  return 'The uploaded file does not appear to match ' + expected + '. Please re-upload the correct document.';
}

function isVisuallyClassifiable(mimeType) {
  const m = String(mimeType || '').trim().toLowerCase();
  return m === 'application/pdf' || m.startsWith('image/');
}

function isDocxMime(mimeType) {
  return String(mimeType || '').trim().toLowerCase() ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

function isDocMime(mimeType) {
  return String(mimeType || '').trim().toLowerCase() === 'application/msword';
}

function buildClassificationPrompt(expectedLabel, extractedText) {
  return 'The user uploaded a document for: ' + String(expectedLabel || 'Unknown').trim() +
    '\n\nExtracted text from the document:\n' + String(extractedText || '').slice(0, 4000) +
    '\n\nBased on the text content, determine if this document matches what was expected. ' +
    'Return ONLY valid JSON: {"matches": true/false, "confidence": 0-100, "identifiedAs": "what it actually is", "reason": "brief explanation"}';
}

module.exports = {
  CONFIDENCE_AUTO_APPROVE,
  CONFIDENCE_VA_REVIEW,
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  isDocMime,
  buildClassificationPrompt
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/document-pipeline.test.js
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/document-pipeline.js tests/document-pipeline.test.js
git commit -m "feat: add document pipeline helpers — confidence routing, classification prompts"
```

---

### Task 5: Google Drive Delete Function

**Files:**
- Modify: `server.js:278-299` (after `uploadToGoogleDrive`)

- [ ] **Step 1: Add deleteGoogleDriveFile function**

Add the following immediately after the `uploadToGoogleDrive` function (after line 299 in server.js):

```javascript
async function deleteGoogleDriveFile(fileId) {
  if (!fileId) return false;
  const drive = await getGoogleDriveClient();
  if (!drive) return false;
  try {
    await drive.files.delete({ fileId: fileId });
    return true;
  } catch (err) {
    if (err.code === 404) return true; // already deleted
    console.error('[GoogleDrive] delete error:', err.message);
    return false;
  }
}
```

- [ ] **Step 2: Verify server starts without errors**

```bash
node -e "require('./server.js')" 2>&1 | head -5
```

Or just check syntax:
```bash
node --check server.js
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add deleteGoogleDriveFile helper for document replacement"
```

---

### Task 6: Push Notification Helper for Documents

**Files:**
- Modify: `server.js` (near existing push notification functions, around line 13552)

- [ ] **Step 1: Add pushDocumentNotification function**

Add the following after the existing `pushCareerNotificationToUser` function (around line 13575 in server.js):

```javascript
async function pushDocumentNotificationToUser(userId, notification) {
  if (!isSupabaseDbConfigured() || !userId) return;
  try {
    const stateResult = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const currentState = stateResult.ok && Array.isArray(stateResult.data) && stateResult.data[0] && typeof stateResult.data[0].state === 'object'
      ? stateResult.data[0].state
      : {};
    const updates = Array.isArray(currentState.gp_link_updates) ? currentState.gp_link_updates : [];
    updates.unshift({
      type: notification.type || 'info',
      title: notification.title || 'Document update',
      detail: notification.detail || '',
      ts: new Date().toISOString()
    });
    if (updates.length > 50) updates.length = 50;
    const nextState = { ...currentState, gp_link_updates: updates };
    await upsertSupabaseUserState(userId, nextState, new Date().toISOString());
  } catch (_) { /* non-critical */ }
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check server.js
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add pushDocumentNotificationToUser for document pipeline alerts"
```

---

### Task 7: Core processDocumentUpload Function

**Files:**
- Modify: `server.js` (add after the push notification helpers, around line 13600)

This is the main pipeline function. It runs in the background after each upload endpoint saves the file.

- [ ] **Step 1: Add the processDocumentUpload function and DOCX text extraction helper**

Add the following in server.js after the push notification functions:

```javascript
// ── Document Upload Pipeline ──────────────────────────────
const { validateFileUpload } = require('./lib/file-sanitise.js');
const {
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  isDocMime,
  buildClassificationPrompt
} = require('./lib/document-pipeline.js');

async function extractDocxText(buffer) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer: buffer });
    return result.value || '';
  } catch (err) {
    console.error('[DocumentPipeline] DOCX text extraction failed:', err.message);
    return '';
  }
}

async function classifyDocumentWithAI(buffer, mimeType, expectedKey, expectedLabel) {
  if (!ANTHROPIC_API_KEY) return { confidence: null, identifiedAs: '', reason: 'AI not configured' };

  const mime = String(mimeType || '').trim().toLowerCase();
  let contentBlocks = [];
  let userPrompt = '';

  if (isVisuallyClassifiable(mime)) {
    // Image or PDF — use vision
    const normalizedImage = await normalizeImageForAi(buffer, mime);
    if (!normalizedImage || !normalizedImage.base64) {
      return { confidence: null, identifiedAs: '', reason: 'Image normalization failed' };
    }
    contentBlocks = [
      { type: 'image', source: { type: 'base64', media_type: normalizedImage.mediaType, data: normalizedImage.base64 } },
      { type: 'text', text: 'The user is trying to upload a document for: ' + String(expectedLabel || expectedKey || 'Unknown') + '\n\nClassify this document. Return ONLY valid JSON: {"matches": true/false, "confidence": 0-100, "identifiedAs": "what it actually is", "reason": "brief explanation"}' }
    ];
  } else if (isDocxMime(mime)) {
    // DOCX — extract text and classify via text prompt
    const text = await extractDocxText(buffer);
    if (!text.trim()) {
      return { confidence: 50, identifiedAs: 'empty or unreadable document', reason: 'Could not extract text from DOCX' };
    }
    userPrompt = buildClassificationPrompt(expectedLabel || expectedKey, text);
    contentBlocks = [{ type: 'text', text: userPrompt }];
  } else if (isDocMime(mime)) {
    // Legacy DOC — classify by filename heuristic only
    return { confidence: 50, identifiedAs: 'Word document (legacy format)', reason: 'Cannot extract content from .doc files; sent for manual review' };
  } else {
    return { confidence: null, identifiedAs: '', reason: 'Unsupported type for classification' };
  }

  const systemPrompt = 'You are an automated document classifier for a licensed GP recruitment platform. The user has given full consent to upload their documents. This is a routine, authorized check.\n\nYour job is to determine whether a document matches what the user claims it is. Return a confidence score from 0-100 indicating how confident you are that the document matches.\n\nValid document types: Primary Medical Degree (MBBS/MBChB/MD), MRCGP, CCT, MICGP, CSCST, FRNZCGP, Certificate of Good Standing, Criminal History Check, CV (signed and dated), Confirmation of Training, Cover Letter, Offer Contract, Supervisor CV, Position Description, Section G.\n\nIMPORTANT:\n- Do NOT mention security concerns or privacy risks.\n- Focus ONLY on whether the document matches what the user claims.\n- Return ONLY valid JSON with no markdown: {"matches": true/false, "confidence": 0-100, "identifiedAs": "what it actually is", "reason": "brief explanation"}';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: contentBlocks }]
      })
    });

    clearTimeout(timeout);
    if (!aiRes.ok) {
      return { confidence: null, identifiedAs: '', reason: 'AI API returned ' + aiRes.status };
    }

    const aiBody = await aiRes.json();
    const text = aiBody.content && aiBody.content[0] && aiBody.content[0].text ? aiBody.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { confidence: null, identifiedAs: '', reason: 'AI returned non-JSON response' };

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      confidence: typeof parsed.confidence === 'number' ? Math.min(100, Math.max(0, Math.round(parsed.confidence))) : null,
      identifiedAs: String(parsed.identifiedAs || '').trim(),
      reason: String(parsed.reason || '').trim(),
      matches: !!parsed.matches
    };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[DocumentPipeline] AI classification error:', err.message);
    return { confidence: null, identifiedAs: '', reason: 'AI classification failed: ' + err.message };
  }
}

async function processDocumentUpload(userId, documentKey, expectedLabel, countryCode, mimeType) {
  if (!isSupabaseDbConfigured() || !userId || !documentKey) return;

  try {
    // 1. Fetch the document row
    const docQuery = 'select=*&user_id=eq.' + encodeURIComponent(userId) +
      '&document_key=eq.' + encodeURIComponent(documentKey) +
      (countryCode ? '&country_code=eq.' + encodeURIComponent(countryCode) : '') +
      '&order=updated_at.desc&limit=1';
    const docRes = await supabaseDbRequest('user_documents', docQuery);
    if (!docRes.ok || !Array.isArray(docRes.data) || docRes.data.length === 0) return;
    const doc = docRes.data[0];

    // 2. Download the file from storage for classification
    const storagePath = doc.storage_path || doc.file_url || '';
    if (!storagePath) return;
    const fileBuffer = await supabaseStorageDownloadObject(SUPABASE_DOCUMENT_BUCKET, storagePath);
    if (!fileBuffer) return;

    // 3. Run AI classification
    const aiResult = await classifyDocumentWithAI(fileBuffer, mimeType || doc.mime_type, documentKey, expectedLabel);
    const confidence = aiResult.confidence;
    const action = classifyConfidenceAction(confidence);

    // 4. Update AI classification fields on the document
    await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(doc.id), {
      method: 'PATCH',
      body: {
        ai_classification_confidence: confidence,
        ai_classification_result: aiResult.identifiedAs || '',
        updated_at: new Date().toISOString()
      }
    });

    // 5. Route based on confidence
    if (action === 'auto_approve') {
      // Auto-approve: set status, upload to Drive
      const driveFileId = await uploadDocumentToDrive(userId, doc, fileBuffer, mimeType || doc.mime_type);
      await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(doc.id), {
        method: 'PATCH',
        body: {
          status: 'approved',
          reviewed_by: 'ai_auto',
          reviewed_at: new Date().toISOString(),
          google_drive_file_id: driveFileId || '',
          rejection_reason: '',
          updated_at: new Date().toISOString()
        }
      });
      // Auto-close any existing open doc_review task for this document
      await autoCloseDocReviewTask(userId, documentKey);
      // No notification for auto-approve

    } else if (action === 'va_review') {
      // VA review: set status, create task
      await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(doc.id), {
        method: 'PATCH',
        body: { status: 'under_review', rejection_reason: '', updated_at: new Date().toISOString() }
      });
      await createDocReviewTask(userId, documentKey, expectedLabel, confidence, aiResult);
      await pushDocumentNotificationToUser(userId, {
        type: 'info',
        title: (expectedLabel || documentKey) + ' under review',
        detail: 'We\'re reviewing your document. This usually takes less than 24 hours.'
      });

    } else {
      // Auto-reject: set status with reason
      const reason = buildRejectionMessage(aiResult.identifiedAs, expectedLabel || documentKey);
      await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(doc.id), {
        method: 'PATCH',
        body: { status: 'rejected', rejection_reason: reason, updated_at: new Date().toISOString() }
      });
      await pushDocumentNotificationToUser(userId, {
        type: 'action',
        title: (expectedLabel || documentKey) + ' needs attention',
        detail: reason
      });
    }
  } catch (err) {
    console.error('[DocumentPipeline] processDocumentUpload error:', err.message);
  }
}

async function uploadDocumentToDrive(userId, docRow, fileBuffer, mimeType) {
  if (!isGoogleDriveConfigured() || !fileBuffer) return '';
  try {
    // Find or create the GP's case to get/create Drive folder
    const caseRes = await supabaseDbRequest('registration_cases', 'select=id,google_drive_folder_id&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const gpCase = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0] : null;
    if (!gpCase) return '';

    const folderId = await ensureGPDriveFolder(gpCase.id, null, null);
    if (!folderId) return '';

    // Delete previous Drive file for this document key if it exists
    const oldDriveFileId = docRow.google_drive_file_id || '';
    if (oldDriveFileId) {
      await deleteGoogleDriveFile(oldDriveFileId);
    }

    // Upload new file
    const fileName = docRow.file_name || docRow.document_key || 'document';
    const driveFile = await uploadToGoogleDrive(folderId, fileName, fileBuffer, mimeType || 'application/pdf');
    return driveFile && driveFile.id ? driveFile.id : '';
  } catch (err) {
    console.error('[DocumentPipeline] Drive upload error:', err.message);
    return '';
  }
}

async function createDocReviewTask(userId, documentKey, expectedLabel, confidence, aiResult) {
  // Find the GP's registration case
  const caseRes = await supabaseDbRequest('registration_cases', 'select=id&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
  const gpCase = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0] : null;
  if (!gpCase) return null;

  // Check if there's already an open task for this document
  const existingRes = await supabaseDbRequest('registration_tasks',
    'select=id,status&case_id=eq.' + encodeURIComponent(gpCase.id) +
    '&task_type=eq.doc_review&related_document_key=eq.' + encodeURIComponent(documentKey) +
    '&status=in.(open,in_progress,waiting)&limit=1');
  const existing = existingRes.ok && Array.isArray(existingRes.data) && existingRes.data[0] ? existingRes.data[0] : null;

  if (existing) {
    // Re-upload: reset existing task to open
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(existing.id), {
      method: 'PATCH',
      body: {
        status: 'open',
        ai_match_confidence: confidence,
        ai_match_reasoning: aiResult.reason || '',
        updated_at: new Date().toISOString()
      }
    });
    await supabaseDbRequest('task_timeline', '', {
      method: 'POST',
      body: [{ task_id: existing.id, case_id: gpCase.id, event_type: 'system', title: 'Document re-uploaded, task reopened', detail: 'AI confidence: ' + (confidence || 'N/A') + '%. Identified as: ' + (aiResult.identifiedAs || 'unknown'), actor: 'system' }]
    });
    return existing;
  }

  // Get GP name for task title
  const profileRes = await supabaseDbRequest('user_profiles', 'select=first_name,last_name&id=eq.' + encodeURIComponent(userId) + '&limit=1');
  const profile = profileRes.ok && Array.isArray(profileRes.data) && profileRes.data[0] ? profileRes.data[0] : {};
  const gpName = [profile.first_name || '', profile.last_name || ''].join(' ').trim() || 'GP';

  return _createRegTask(gpCase.id, {
    task_type: 'doc_review',
    title: 'Review uploaded ' + (expectedLabel || documentKey) + ' for Dr ' + gpName,
    priority: 'normal',
    status: 'open',
    source_trigger: 'doc_upload',
    related_document_key: documentKey,
    ai_match_confidence: confidence,
    ai_match_reasoning: aiResult.reason || '',
    _actor: 'system'
  });
}

async function autoCloseDocReviewTask(userId, documentKey) {
  const caseRes = await supabaseDbRequest('registration_cases', 'select=id&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
  const gpCase = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0] : null;
  if (!gpCase) return;

  const taskRes = await supabaseDbRequest('registration_tasks',
    'select=id&case_id=eq.' + encodeURIComponent(gpCase.id) +
    '&task_type=eq.doc_review&related_document_key=eq.' + encodeURIComponent(documentKey) +
    '&status=in.(open,in_progress,waiting)&limit=1');
  const task = taskRes.ok && Array.isArray(taskRes.data) && taskRes.data[0] ? taskRes.data[0] : null;
  if (task) {
    await _completeRegTask(task.id, gpCase.id, 'ai_auto');
  }
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check server.js
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add processDocumentUpload pipeline — AI classification, Drive upload, VA task creation"
```

---

### Task 8: Wire Pipeline into Upload Endpoints

**Files:**
- Modify: `server.js:19430` (PUT /api/prepared-documents)
- Modify: `server.js:19478` (PUT /api/onboarding-documents)
- Modify: `server.js:15981` (POST /api/career/upload-cv)
- Modify: `server.js:19142` (PUT /api/account/career-documents)

Each endpoint needs two changes: (a) set initial status to `"processing"` and (b) fire `processDocumentUpload()` in the background after returning the response.

- [ ] **Step 1: Wire PUT /api/prepared-documents (line 19430)**

In the `PUT /api/prepared-documents` handler, after `const saved = await savePreparedDocumentForUser(...)`, change the response block. Find this code (around line 19463-19475):

```javascript
    const saved = await savePreparedDocumentForUser(userId, email, payload);
    if (!saved) {
      sendJson(res, 502, { ok: false, message: 'Failed to persist prepared document.' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      document: {
        ...saved
      }
    });
    return;
```

Replace with:

```javascript
    const saved = await savePreparedDocumentForUser(userId, email, payload);
    if (!saved) {
      sendJson(res, 502, { ok: false, message: 'Failed to persist prepared document.' });
      return;
    }

    // Set status to processing and return immediately
    await supabaseDbRequest('user_documents',
      'user_id=eq.' + encodeURIComponent(userId) + '&document_key=eq.' + encodeURIComponent(payload.key) + '&country_code=eq.' + encodeURIComponent(payload.country),
      { method: 'PATCH', body: { status: 'processing', updated_at: new Date().toISOString() } });

    sendJson(res, 200, {
      ok: true,
      document: { ...saved, status: 'processing' }
    });

    // Background: run document pipeline
    const docLabel = getDocumentLabelForKey(payload.key) || payload.key;
    processDocumentUpload(userId, payload.key, docLabel, payload.country, payload.mimeType).catch(function (err) {
      console.error('[DocumentPipeline] background error:', err.message);
    });
    return;
```

- [ ] **Step 2: Wire PUT /api/onboarding-documents (line 19478)**

Apply the same pattern to the onboarding-documents handler. Find the success response block in that handler (similar structure to prepared-documents) and add the same processing + background call pattern. The onboarding handler uses the same `savePreparedDocumentForUser` or similar save function — look for the `sendJson(res, 200, ...)` at the end of that handler and add the pipeline call before `return`:

```javascript
    // Background: run document pipeline
    const onboardDocLabel = getDocumentLabelForKey(payload.key) || payload.key;
    processDocumentUpload(userId, payload.key, onboardDocLabel, payload.country, payload.mimeType).catch(function (err) {
      console.error('[DocumentPipeline] background error:', err.message);
    });
```

- [ ] **Step 3: Wire POST /api/career/upload-cv (line 15981)**

In the career/upload-cv handler, after the file is saved and before `return`, add:

```javascript
    // Background: run document pipeline
    processDocumentUpload(userId, 'cv_signed_dated', 'CV (Signed and dated)', 'AU', 'application/pdf').catch(function (err) {
      console.error('[DocumentPipeline] background error:', err.message);
    });
```

- [ ] **Step 4: Wire PUT /api/account/career-documents (line 19142)**

In the account/career-documents handler, after the file is saved and before `return`, add:

```javascript
    // Background: run document pipeline
    const careerDocMeta = ACCOUNT_CAREER_DOCUMENT_TYPES[payload.type];
    if (careerDocMeta) {
      processDocumentUpload(userId, careerDocMeta.key, careerDocMeta.label, 'AU', payload.mimeType).catch(function (err) {
        console.error('[DocumentPipeline] background error:', err.message);
      });
    }
```

- [ ] **Step 5: Add getDocumentLabelForKey helper**

Add this helper near the document constants (around line 1140 in server.js):

```javascript
function getDocumentLabelForKey(key) {
  const normalizedKey = String(key || '').trim();
  const labels = {
    primary_medical_degree: 'Primary Medical Degree',
    mrcgp: 'MRCGP Certificate',
    cct: 'Certificate of Completion of Training',
    pmetb: 'PMETB Certificate',
    micgp: 'MICGP Certificate',
    cscst: 'CSCST Certificate',
    frnzcgp: 'FRNZCGP Fellowship Certificate',
    certificate_of_good_standing: 'Certificate of Good Standing',
    criminal_history_check: 'Criminal History Check',
    cv_signed_dated: 'CV (Signed and dated)',
    career_cover_letter: 'Cover Letter',
    confirmation_of_training: 'Confirmation of Training',
    onboarding_specialist_qualification: 'Specialist Qualification',
    onboarding_primary_med_degree: 'Primary Medical Degree'
  };
  return labels[normalizedKey] || '';
}
```

- [ ] **Step 6: Verify syntax**

```bash
node --check server.js
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: wire document pipeline into all GP upload endpoints"
```

---

### Task 9: VA Approve/Reject Endpoints for doc_review Tasks

**Files:**
- Modify: `server.js` (add new endpoint near line 21325)

- [ ] **Step 1: Add POST /api/admin/va/doc-review/approve endpoint**

Add this before the existing `/api/admin/va/task/approve-document` handler:

```javascript
  // VA: approve a doc_review task — marks document as approved, uploads to Drive
  if (pathname === '/api/admin/va/doc-review/approve' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const body = await readJsonBody(req);
    const taskId = String(body.task_id || '').trim();
    if (!taskId) { sendJson(res, 400, { ok: false, message: 'task_id required.' }); return; }

    const taskRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&task_type=eq.doc_review&limit=1');
    if (!taskRes.ok || !taskRes.data[0]) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    const task = taskRes.data[0];

    const caseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    const userId = caseRes.ok && caseRes.data[0] ? caseRes.data[0].user_id : null;
    if (!userId) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }

    // Get the document row
    const docKey = task.related_document_key;
    const docRes = await supabaseDbRequest('user_documents', 'select=*&user_id=eq.' + encodeURIComponent(userId) + '&document_key=eq.' + encodeURIComponent(docKey) + '&order=updated_at.desc&limit=1');
    const doc = docRes.ok && Array.isArray(docRes.data) && docRes.data[0] ? docRes.data[0] : null;

    // Upload to Drive
    let driveFileId = '';
    if (doc && doc.storage_path) {
      const fileBuffer = await supabaseStorageDownloadObject(SUPABASE_DOCUMENT_BUCKET, doc.storage_path || doc.file_url || '');
      if (fileBuffer) {
        driveFileId = await uploadDocumentToDrive(userId, doc, fileBuffer, doc.mime_type);
      }
    }

    // Update document status
    if (doc) {
      await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(doc.id), {
        method: 'PATCH',
        body: {
          status: 'approved',
          reviewed_by: adminCtx.email,
          reviewed_at: new Date().toISOString(),
          google_drive_file_id: driveFileId || '',
          rejection_reason: '',
          updated_at: new Date().toISOString()
        }
      });
    }

    // Complete the task
    await _completeRegTask(taskId, task.case_id, adminCtx.email);

    // Notify GP
    const docLabel = getDocumentLabelForKey(docKey) || docKey;
    await pushDocumentNotificationToUser(userId, {
      type: 'success',
      title: docLabel + ' verified',
      detail: 'Your document has been reviewed and verified. You can download it from My Documents.'
    });

    sendJson(res, 200, { ok: true, message: 'Document approved.' });
    return;
  }

  // VA: reject a doc_review task — marks document as rejected with reason
  if (pathname === '/api/admin/va/doc-review/reject' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const body = await readJsonBody(req);
    const taskId = String(body.task_id || '').trim();
    const reason = String(body.reason || '').trim();
    if (!taskId) { sendJson(res, 400, { ok: false, message: 'task_id required.' }); return; }
    if (!reason) { sendJson(res, 400, { ok: false, message: 'reason required.' }); return; }

    const taskRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&task_type=eq.doc_review&limit=1');
    if (!taskRes.ok || !taskRes.data[0]) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    const task = taskRes.data[0];

    const caseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    const userId = caseRes.ok && caseRes.data[0] ? caseRes.data[0].user_id : null;
    if (!userId) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }

    // Update document status
    const docKey = task.related_document_key;
    await supabaseDbRequest('user_documents',
      'user_id=eq.' + encodeURIComponent(userId) + '&document_key=eq.' + encodeURIComponent(docKey),
      {
        method: 'PATCH',
        body: {
          status: 'rejected',
          rejection_reason: reason,
          reviewed_by: adminCtx.email,
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      });

    // Set task to waiting (waiting on GP re-upload)
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), {
      method: 'PATCH',
      body: { status: 'waiting', updated_at: new Date().toISOString() }
    });
    await supabaseDbRequest('task_timeline', '', {
      method: 'POST',
      body: [{ task_id: taskId, case_id: task.case_id, event_type: 'status_change', title: 'Document rejected — waiting on GP', detail: reason, actor: adminCtx.email }]
    });

    // Notify GP
    const docLabel = getDocumentLabelForKey(docKey) || docKey;
    await pushDocumentNotificationToUser(userId, {
      type: 'action',
      title: docLabel + ' needs attention',
      detail: reason + ' Please re-upload from My Documents.'
    });

    sendJson(res, 200, { ok: true, message: 'Document rejected.' });
    return;
  }
```

- [ ] **Step 2: Verify syntax**

```bash
node --check server.js
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add VA doc-review approve/reject endpoints with Drive upload and notifications"
```

---

### Task 10: Update My Documents Frontend — Processing Status + Rejection Reason

**Files:**
- Modify: `pages/my-documents.html:1896-1919` (statusClass and statusLabel functions)

- [ ] **Step 1: Add "processing" status to statusClass function**

In `pages/my-documents.html`, find the `statusClass` function (around line 1896). Add support for the `"processing"` status. Find:

```javascript
      "review"   → "under_review" | "uploaded" | "requested" | "scanning"
```

The function likely uses if/else or switch. Add `"processing"` to the review group. Find this pattern and add `|| s === "processing"` to the review condition.

- [ ] **Step 2: Add "processing" to statusLabel function**

In the `statusLabel` function (around line 1907), add a mapping for `"processing"` → `"Processing"`.

- [ ] **Step 3: Show rejection reason on rejected document cards**

In the document card rendering code, after the status badge, add a rejection reason display. Find where rejected status is rendered and add:

```javascript
if (doc.status === 'rejected' && doc.rejection_reason) {
  html += '<p class="doc-rejection-reason" style="color:#b45309;font-size:13px;margin:6px 0 0;font-weight:500;">' + escapeHtml(doc.rejection_reason) + '</p>';
}
```

- [ ] **Step 4: Verify the page loads without errors**

Open `http://localhost:3000/pages/my-documents.html` in a browser and check the console for JS errors.

- [ ] **Step 5: Commit**

```bash
git add pages/my-documents.html
git commit -m "feat: add processing status and rejection reason display to My Documents"
```

---

### Task 11: Update My Documents — Fetch rejection_reason and google_drive_file_id from API

**Files:**
- Modify: `server.js` (the GET /api/prepared-documents response mapper)

- [ ] **Step 1: Include new columns in the document row mapper**

Find the `mapPreparedDocumentRow` function in server.js (search for `function mapPreparedDocumentRow`). Add the new fields to the returned object:

```javascript
    rejection_reason: row.rejection_reason || '',
    ai_classification_confidence: row.ai_classification_confidence || null,
    ai_classification_result: row.ai_classification_result || '',
    google_drive_file_id: row.google_drive_file_id || ''
```

- [ ] **Step 2: Verify syntax**

```bash
node --check server.js
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: include rejection_reason and AI classification fields in document API response"
```

---

### Task 12: File Sanitisation in Upload Endpoints

**Files:**
- Modify: `server.js:19430` (PUT /api/prepared-documents — add validation call)

- [ ] **Step 1: Add file validation to the prepared-documents handler**

In the `PUT /api/prepared-documents` handler, after `const payload = sanitizePreparedDocumentPayload(body)` and before the save call, add file validation. Find the payload validation check (around line 19451-19455) and add after it:

```javascript
    // Validate file security
    if (payload.fileDataUrl) {
      const fileBuffer = Buffer.from(payload.fileDataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
      const fileCheck = validateFileUpload(fileBuffer, payload.mimeType, payload.fileName);
      if (!fileCheck.valid) {
        sendJson(res, 400, { ok: false, message: fileCheck.errors[0] || 'File validation failed.' });
        return;
      }
      payload.fileName = fileCheck.sanitisedFileName;
    }
```

Note: The `validateFileUpload` function is already required at the top of the pipeline section. If the require is placed after this handler in the file, move the require statement to the top of server.js with the other requires, or add it before this handler:

```javascript
const { validateFileUpload } = require('./lib/file-sanitise.js');
```

- [ ] **Step 2: Add the same validation to the other upload handlers**

Apply the same pattern to:
- `PUT /api/onboarding-documents` (line 19478)
- `PUT /api/account/career-documents` (line 19142)
- `POST /api/career/upload-cv` (line 15981)

Each handler should validate the file buffer before saving.

- [ ] **Step 3: Verify syntax**

```bash
node --check server.js
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add file sanitisation to all upload endpoints — magic bytes, PDF safety, MIME validation"
```

---

### Task 13: Integration Test — End-to-End Pipeline

**Files:**
- Create: `tests/document-pipeline-integration.test.js`

- [ ] **Step 1: Write integration tests**

```javascript
// tests/document-pipeline-integration.test.js
const { describe, it, expect } = require('vitest');
const { validateFileUpload } = require('../lib/file-sanitise.js');
const {
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  buildClassificationPrompt
} = require('../lib/document-pipeline.js');

describe('Document Pipeline Integration', () => {
  describe('Full validation + classification flow', () => {
    it('accepts a valid PDF and routes high confidence to auto_approve', () => {
      const buf = Buffer.from('%PDF-1.4\nvalid content\n%%EOF');
      const result = validateFileUpload(buf, 'application/pdf', 'my-degree.pdf');
      expect(result.valid).toBe(true);
      expect(result.sanitisedFileName).toBe('my-degree.pdf');
      expect(isVisuallyClassifiable('application/pdf')).toBe(true);
      expect(classifyConfidenceAction(85)).toBe('auto_approve');
    });

    it('accepts a valid JPEG and routes medium confidence to va_review', () => {
      const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      const result = validateFileUpload(buf, 'image/jpeg', 'scan.jpg');
      expect(result.valid).toBe(true);
      expect(isVisuallyClassifiable('image/jpeg')).toBe(true);
      expect(classifyConfidenceAction(55)).toBe('va_review');
    });

    it('accepts DOCX and routes to text classification', () => {
      const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]);
      const result = validateFileUpload(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter.docx');
      expect(result.valid).toBe(true);
      expect(isDocxMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
      expect(isVisuallyClassifiable('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    });

    it('rejects dangerous PDF', () => {
      const buf = Buffer.from('%PDF-1.4\n/JavaScript (alert("xss"))\n%%EOF');
      const result = validateFileUpload(buf, 'application/pdf', 'evil.pdf');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('dangerous');
    });

    it('rejects mismatched magic bytes', () => {
      const buf = Buffer.from('this is not a pdf');
      const result = validateFileUpload(buf, 'application/pdf', 'fake.pdf');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('does not match');
    });

    it('rejects oversized files', () => {
      const buf = Buffer.alloc(11 * 1024 * 1024); // 11MB
      buf[0] = 0x25; buf[1] = 0x50; buf[2] = 0x44; buf[3] = 0x46; // %PDF header
      const result = validateFileUpload(buf, 'application/pdf', 'big.pdf');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('10MB');
    });

    it('builds correct rejection message', () => {
      const msg = buildRejectionMessage('passport scan', 'MRCGP Certificate');
      expect(msg).toBe('This appears to be a passport scan but we expected a MRCGP Certificate. Please re-upload the correct document.');
    });

    it('builds DOCX classification prompt with text', () => {
      const prompt = buildClassificationPrompt('CV (Signed and dated)', 'Dr John Smith\nMBBS University of London\nExperience: 10 years GP');
      expect(prompt).toContain('CV (Signed and dated)');
      expect(prompt).toContain('Dr John Smith');
    });

    it('low confidence routes to auto_reject', () => {
      expect(classifyConfidenceAction(15)).toBe('auto_reject');
    });

    it('null confidence routes to va_review (safe fallback)', () => {
      expect(classifyConfidenceAction(null)).toBe('va_review');
    });
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run tests/file-sanitise.test.js tests/document-pipeline.test.js tests/document-pipeline-integration.test.js
```

Expected: all tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/document-pipeline-integration.test.js
git commit -m "test: add integration tests for document pipeline — validation, routing, rejection messages"
```

---

### Task 14: Move require Statements to Top of server.js

**Files:**
- Modify: `server.js` (top of file, near other requires)

- [ ] **Step 1: Move lib requires to the top of server.js**

Near the top of server.js where other requires are (around line 83 after the Zoho Sign require), add:

```javascript
const { validateFileUpload } = require('./lib/file-sanitise.js');
const {
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  isDocMime,
  buildClassificationPrompt
} = require('./lib/document-pipeline.js');
```

Remove the duplicate require statements from inside the `processDocumentUpload` section (Task 7) since they're now at the top.

- [ ] **Step 2: Verify syntax**

```bash
node --check server.js
```

Expected: no errors

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: all tests PASS

- [ ] **Step 4: Commit and push**

```bash
git add server.js
git commit -m "refactor: move document pipeline requires to top of server.js"
git push
```
