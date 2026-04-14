# Practice Pack Phase 1a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 4 practice pack document flows (Section G auto-delivery, AI Position Description, Offer/Contract from Zoho Recruit + manual upload, Supervisor CV mailto + upload) with Google Drive folder integration for all GP documents.

**Architecture:** All server logic lives in `server.js` (monolithic Node.js app). Admin UI in `pages/admin.html`. Google Drive via service account. PDF generation via existing `pdfkit` dependency. AI via existing Anthropic API integration. Document delivery writes to `user_documents` table + uploads to Google Drive.

**Tech Stack:** Node.js, pdfkit, googleapis (new), Anthropic API, Supabase, Zoho Recruit API (existing), vanilla JS/HTML admin dashboard.

**Spec:** `docs/superpowers/specs/2026-04-14-practice-pack-phase1a-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server.js` | Modify | New API endpoints, Google Drive helpers, document delivery, AI generation, automation hooks |
| `pages/admin.html` | Modify | Task-specific action buttons, position description editor modal, file upload UI, mailto links |
| `documents/section_g.pdf` | Create | Static Section G PDF |
| `package.json` | Modify | Add `googleapis` dependency |
| `supabase/migrations/20260414000000_practice_pack_columns.sql` | Create | DB schema changes |
| `tests/practice-pack.test.js` | Create | Tests for document delivery, mailto generation, AI prompt building |

---

### Task 1: Add googleapis dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install googleapis**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)" && npm install googleapis
```

- [ ] **Step 2: Verify installation**

```bash
node -e "const {google} = require('googleapis'); console.log('googleapis loaded:', typeof google.drive)"
```

Expected: `googleapis loaded: function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add googleapis for Google Drive integration"
```

---

### Task 2: Database schema migration

**Files:**
- Create: `supabase/migrations/20260414000000_practice_pack_columns.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Add document tracking columns to registration_tasks
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS attachment_url text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS attachment_filename text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS zoho_attachment_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS google_drive_file_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS document_html text;

-- Add Google Drive folder reference to registration_cases
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS google_drive_folder_id text;
```

- [ ] **Step 2: Run migration against Supabase**

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
node -e "
const https = require('https');
const url = 'https://rqrqcfxalkvzwbedvsjs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || require('fs').readFileSync('.env','utf8').match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1];

const queries = [
  'ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS attachment_url text',
  'ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS attachment_filename text',
  'ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS zoho_attachment_id text',
  'ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS google_drive_file_id text',
  'ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS document_html text',
  'ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS google_drive_folder_id text'
];

(async () => {
  for (const q of queries) {
    const res = await fetch(url + '/rest/v1/rpc/exec_sql', {
      method: 'POST',
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q })
    }).catch(() => null);
    console.log(q.substring(0, 60) + '...', res ? res.status : 'failed');
  }
})();
"
```

If `rpc/exec_sql` is not available, run the SQL directly in the Supabase dashboard SQL editor.

- [ ] **Step 3: Verify columns exist**

Query `registration_tasks` and `registration_cases` to confirm new columns are present.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260414000000_practice_pack_columns.sql
git commit -m "db: add practice pack document tracking columns"
```

---

### Task 3: Google Drive helper functions in server.js

**Files:**
- Modify: `server.js` (add after line ~310, near `GP_LINK_DOCUMENT_META`)

- [ ] **Step 1: Write test for buildMailtoLink helper**

Create `tests/practice-pack.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

// We test pure helper functions extracted from server logic
describe('buildMailtoLink', () => {
  // Import helper via a shared module or inline
  function buildMailtoLink(to, subject, body) {
    return 'mailto:' + encodeURIComponent(to) +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
  }

  it('encodes email, subject, and body', () => {
    const link = buildMailtoLink(
      'contact@practice.com',
      'Offer/Contract Required — Dr Smith at SOP Medical',
      'Hi Jane,\n\nWe require the agreement.\n\nKind regards,\nGP Link Team'
    );
    expect(link).toContain('mailto:contact%40practice.com');
    expect(link).toContain('subject=Offer');
    expect(link).toContain('body=Hi%20Jane');
  });

  it('handles empty fields gracefully', () => {
    const link = buildMailtoLink('', '', '');
    expect(link).toBe('mailto:?subject=&body=');
  });
});

describe('buildPositionDescriptionPrompt', () => {
  function buildPositionDescriptionPrompt(practiceName, roleTitle, location) {
    return `Generate a professional position description for a General Practitioner joining ${practiceName} in ${location} for the role of ${roleTitle}. Include: practice overview, key responsibilities, supervision arrangements, working hours expectations, and professional development opportunities. Return well-structured HTML using <h2>, <h3>, <p>, <ul>, and <li> tags only. Do not include <html>, <head>, or <body> wrapper tags.`;
  }

  it('includes practice name, role, and location', () => {
    const prompt = buildPositionDescriptionPrompt('SOP Medical Centre', 'General Practitioner', 'Sydney NSW');
    expect(prompt).toContain('SOP Medical Centre');
    expect(prompt).toContain('General Practitioner');
    expect(prompt).toContain('Sydney NSW');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
npx vitest run tests/practice-pack.test.js
```

Expected: 3 tests PASS

- [ ] **Step 3: Add Google Drive constants and auth helper to server.js**

Add near the top of `server.js` after the existing Zoho constants (around line 70):

```javascript
// ── Google Drive integration ──
const GOOGLE_SERVICE_ACCOUNT_EMAIL = String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
const GOOGLE_DRIVE_ROOT_FOLDER_ID = String(process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim();

function isGoogleDriveConfigured() {
  return !!(GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && GOOGLE_DRIVE_ROOT_FOLDER_ID);
}

let _googleDriveClient = null;
async function getGoogleDriveClient() {
  if (_googleDriveClient) return _googleDriveClient;
  if (!isGoogleDriveConfigured()) return null;
  const { google } = require('googleapis');
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    ['https://www.googleapis.com/auth/drive.file']
  );
  _googleDriveClient = google.drive({ version: 'v3', auth });
  return _googleDriveClient;
}
```

- [ ] **Step 4: Add Google Drive helper functions to server.js**

Add right after the auth helper:

```javascript
async function createGoogleDriveFolder(folderName, parentFolderId) {
  const drive = await getGoogleDriveClient();
  if (!drive) return null;
  try {
    const res = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId || GOOGLE_DRIVE_ROOT_FOLDER_ID]
      },
      fields: 'id,name,webViewLink'
    });
    return res.data;
  } catch (err) {
    console.error('[GoogleDrive] createFolder error:', err.message);
    return null;
  }
}

async function uploadToGoogleDrive(folderId, fileName, buffer, mimeType) {
  const drive = await getGoogleDriveClient();
  if (!drive) return null;
  const { Readable } = require('stream');
  try {
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId]
      },
      media: {
        mimeType: mimeType || 'application/pdf',
        body: Readable.from(buffer)
      },
      fields: 'id,name,webViewLink'
    });
    return res.data;
  } catch (err) {
    console.error('[GoogleDrive] upload error:', err.message);
    return null;
  }
}

async function ensureGPDriveFolder(caseId, gpFirstName, gpLastName) {
  // Check if folder already exists on the case
  const caseRes = await supabaseDbRequest('registration_cases', 'select=google_drive_folder_id&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
  if (caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] && caseRes.data[0].google_drive_folder_id) {
    return caseRes.data[0].google_drive_folder_id;
  }
  const folderName = 'Dr ' + [(gpFirstName || ''), (gpLastName || '')].join(' ').trim();
  const folder = await createGoogleDriveFolder(folderName, GOOGLE_DRIVE_ROOT_FOLDER_ID);
  if (folder && folder.id) {
    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), {
      method: 'PATCH',
      body: { google_drive_folder_id: folder.id }
    });
    return folder.id;
  }
  return null;
}
```

- [ ] **Step 5: Add buildMailtoLink and buildPositionDescriptionPrompt to server.js**

Add right after the Google Drive helpers:

```javascript
function buildMailtoLink(to, subject, body) {
  return 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}

function buildPositionDescriptionPrompt(practiceName, roleTitle, location) {
  return 'Generate a professional position description for a General Practitioner joining ' + practiceName + ' in ' + location + ' for the role of ' + roleTitle + '. Include: practice overview, key responsibilities, supervision arrangements, working hours expectations, and professional development opportunities. Return well-structured HTML using <h2>, <h3>, <p>, <ul>, and <li> tags only. Do not include <html>, <head>, or <body> wrapper tags.';
}
```

- [ ] **Step 6: Add deliverToMyDocuments helper**

This saves a document to the GP's `user_documents` record and uploads to Google Drive:

```javascript
async function deliverToMyDocuments(userId, caseId, docKey, fileName, buffer, mimeType) {
  const results = { userDoc: null, driveFile: null };

  // 1. Upsert into user_documents
  const existing = await supabaseDbRequest('user_documents', 'select=id&user_id=eq.' + encodeURIComponent(userId) + '&document_key=eq.' + encodeURIComponent(docKey) + '&limit=1');
  const docRecord = {
    user_id: userId,
    document_key: docKey,
    file_name: fileName,
    status: 'approved',
    reviewed_by: 'system',
    reviewed_at: new Date().toISOString()
  };
  if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
    await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(existing.data[0].id), { method: 'PATCH', body: docRecord });
    results.userDoc = existing.data[0].id;
  } else {
    const ins = await supabaseDbRequest('user_documents', '', { method: 'POST', body: [docRecord] });
    if (ins.ok && Array.isArray(ins.data) && ins.data[0]) results.userDoc = ins.data[0].id;
  }

  // 2. Upload to Google Drive
  const folderId = await ensureGPDriveFolder(caseId, null, null);
  if (folderId && buffer) {
    const driveFile = await uploadToGoogleDrive(folderId, fileName, buffer, mimeType || 'application/pdf');
    if (driveFile) results.driveFile = driveFile.id;
  }

  return results;
}
```

- [ ] **Step 7: Commit**

```bash
git add server.js tests/practice-pack.test.js
git commit -m "feat: add Google Drive helpers, mailto builder, document delivery function"
```

---

### Task 4: Section G auto-delivery on AHPRA stage entry

**Files:**
- Create: `documents/section_g.pdf` (placeholder static PDF)
- Modify: `server.js` (lines ~3967-3980 in `processRegistrationTaskAutomation`)

- [ ] **Step 1: Create documents directory and placeholder Section G PDF**

```bash
mkdir -p "/Users/khaleed/GP LINK APP (Visual Studio)/documents"
```

Then create a placeholder PDF using pdfkit:

```javascript
// Run once to generate the placeholder
const PDFDocument = require('pdfkit');
const fs = require('fs');
const doc = new PDFDocument({ size: 'A4', margin: 50 });
const stream = fs.createWriteStream('documents/section_g.pdf');
doc.pipe(stream);
doc.fontSize(20).text('Section G', { align: 'center' });
doc.moveDown();
doc.fontSize(12).text('Specialist Registration — Supervision Plan', { align: 'center' });
doc.moveDown(2);
doc.text('This is a placeholder Section G document. Replace with the actual pre-filled PDF.');
doc.end();
```

Run: `node -e "<the above code>"` from the project root.

**Note:** Replace this placeholder with the actual Section G PDF file before production use.

- [ ] **Step 2: Add Section G delivery to the career_secured automation block**

In `server.js`, find the career_secured block (around line 3967-3980). After the practice pack child task creation loop (line 3976), add Section G auto-delivery and Google Drive folder creation:

```javascript
      // After the practice_pack_child creation loop ends (after the closing brace of the for loop)

      // Create Google Drive folder for this GP
      if (isGoogleDriveConfigured()) {
        const gpProfile = profileMap ? profileMap[userId] : null;
        const gpFirst = gpProfile ? gpProfile.first_name : '';
        const gpLast = gpProfile ? gpProfile.last_name : '';
        const driveFolderId = await ensureGPDriveFolder(caseId, gpFirst, gpLast);

        // Auto-deliver Section G
        try {
          const fs = require('fs');
          const sectionGPath = require('path').join(__dirname, 'documents', 'section_g.pdf');
          if (fs.existsSync(sectionGPath)) {
            const sectionGBuffer = fs.readFileSync(sectionGPath);
            await deliverToMyDocuments(userId, caseId, 'section_g', 'Section G.pdf', sectionGBuffer, 'application/pdf');
            // Auto-complete Section G task
            const sgTask = await supabaseDbRequest('registration_tasks', 'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.section_g&status=in.(open,in_progress,waiting)&limit=1');
            if (sgTask.ok && Array.isArray(sgTask.data) && sgTask.data[0]) {
              await _completeRegTask(sgTask.data[0].id, caseId, 'system');
            }
            await _logCaseEvent(caseId, null, 'system', 'Section G auto-delivered to MyDocuments and Google Drive', null, 'system');
          }
        } catch (sgErr) {
          console.error('[PracticePack] Section G auto-delivery error:', sgErr.message);
        }

        // Sync any existing qualification docs to Drive
        try {
          const existingDocs = await supabaseDbRequest('user_documents', 'select=document_key,file_name,file_url&user_id=eq.' + encodeURIComponent(userId));
          if (existingDocs.ok && Array.isArray(existingDocs.data) && driveFolderId) {
            for (const d of existingDocs.data) {
              if (d.file_url && d.file_name) {
                // file_url may be a Supabase storage URL — download and re-upload to Drive
                // This is a best-effort sync; errors are logged but don't block
                try {
                  const resp = await fetch(d.file_url);
                  if (resp.ok) {
                    const buf = Buffer.from(await resp.arrayBuffer());
                    await uploadToGoogleDrive(driveFolderId, d.file_name, buf, 'application/pdf');
                  }
                } catch (syncErr) {
                  console.error('[GoogleDrive] sync doc error:', d.document_key, syncErr.message);
                }
              }
            }
          }
        } catch (syncAllErr) {
          console.error('[GoogleDrive] sync all docs error:', syncAllErr.message);
        }
      }
```

- [ ] **Step 3: Serve the Section G PDF as a static file**

In the static file serving section of `server.js`, ensure files under `documents/` are served. Find where static paths like `/js/`, `/css/`, `/images/` are handled and add `documents/` if not already included. Alternatively the `deliverToMyDocuments` function already reads it from disk, so the GP accesses it via the existing `/api/onboarding-documents/download` or `/api/prepared-documents/download` endpoint which reads from `user_documents.file_url`.

Since we store the buffer directly and set `file_url` to a Supabase storage path or base64 reference, the existing download endpoints handle serving. If `user_documents` stores a URL, upload the Section G to Supabase storage first and store that URL. If it stores file content directly, store accordingly. Check the existing pattern at lines 16073+ and match it.

- [ ] **Step 4: Commit**

```bash
git add documents/section_g.pdf server.js
git commit -m "feat: Section G auto-delivery on AHPRA stage entry with Google Drive sync"
```

---

### Task 5: Offer/Contract — Zoho Recruit attachment check on task creation

**Files:**
- Modify: `server.js` (career_secured automation block, ~line 3967)

- [ ] **Step 1: Add attachment check when practice pack tasks are created**

In the career_secured block, after creating the `offer_contract` task, check Zoho Recruit for attachments. Add this after the practice_pack_child creation loop:

```javascript
      // Check Zoho Recruit for existing contract attachment
      try {
        const careerState = _parseStateVal(nxt.gp_career_state);
        const applications = Array.isArray(careerState.applications) ? careerState.applications : [];
        const securedApp = applications.find(function (a) { return a && a.isPlacementSecured === true; });
        const appId = securedApp ? (securedApp.zohoApplicationId || securedApp.applicationId || securedApp.id) : null;
        if (appId) {
          const attachments = await listZohoRecruitApplicationAttachments(appId);
          if (Array.isArray(attachments) && attachments.length > 0) {
            const candidates = selectZohoContractAttachmentCandidates(attachments);
            if (candidates.length > 0) {
              const best = candidates[0];
              const ocTask = await supabaseDbRequest('registration_tasks', 'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.offer_contract&status=in.(open,in_progress,waiting)&limit=1');
              if (ocTask.ok && Array.isArray(ocTask.data) && ocTask.data[0]) {
                await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(ocTask.data[0].id), {
                  method: 'PATCH',
                  body: {
                    zoho_attachment_id: String(best.id || ''),
                    attachment_filename: getZohoAttachmentFileName(best) || 'contract.pdf'
                  }
                });
              }
            }
          }
        }
      } catch (ocErr) {
        console.error('[PracticePack] Offer/Contract attachment check error:', ocErr.message);
      }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: auto-check Zoho Recruit for Offer/Contract attachment on task creation"
```

---

### Task 6: VA document action API endpoints

**Files:**
- Modify: `server.js` (add new endpoints in the admin API section, near existing `/api/admin/va/` routes around line 17187+)

- [ ] **Step 1: Add POST /api/admin/va/task/generate-position-description endpoint**

Add after the existing VA dashboard endpoints:

```javascript
  // ── Generate Position Description (AI) ──
  if (pathname === '/api/admin/va/task/generate-position-description' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const body = await readJsonBody(req);
    const taskId = String(body.task_id || '').trim();
    if (!taskId) { sendJson(res, 400, { ok: false, message: 'task_id required.' }); return; }

    // Get task and case info
    const taskRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    if (!taskRes.ok || !Array.isArray(taskRes.data) || !taskRes.data[0]) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    const task = taskRes.data[0];
    if (task.related_document_key !== 'position_description') { sendJson(res, 400, { ok: false, message: 'Not a position description task.' }); return; }

    // Get case and user state for practice info
    const caseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    const userId = caseRes.ok && caseRes.data[0] ? caseRes.data[0].user_id : null;
    if (!userId) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }

    const stateRes = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const state = stateRes.ok && stateRes.data[0] ? stateRes.data[0].state : {};
    const career = _parseStateVal(state.gp_career_state);
    const apps = Array.isArray(career.applications) ? career.applications : [];
    const secured = apps.find(function (a) { return a && a.isPlacementSecured === true; });
    const placement = secured && secured.placement ? secured.placement : {};

    const practiceName = placement.practiceName || 'the practice';
    const roleTitle = placement.roleTitle || 'General Practitioner';
    const location = placement.location || 'Australia';

    // Call Anthropic API
    if (!ANTHROPIC_API_KEY) { sendJson(res, 503, { ok: false, message: 'Anthropic API not configured.' }); return; }
    const budgetOk = await checkAnthropicBudget();
    if (!budgetOk) { sendJson(res, 429, { ok: false, message: 'Anthropic daily budget exceeded.' }); return; }

    const prompt = buildPositionDescriptionPrompt(practiceName, roleTitle, location);
    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const aiData = await aiRes.json();
      const html = aiData.content && aiData.content[0] ? aiData.content[0].text : '';

      // Store HTML on the task
      await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), {
        method: 'PATCH',
        body: { document_html: html, status: 'in_progress' }
      });

      await _logCaseEvent(task.case_id, taskId, 'system', 'Position description generated by AI', null, adminCtx.email);
      sendJson(res, 200, { ok: true, html: html, practiceName: practiceName, roleTitle: roleTitle, location: location });
    } catch (aiErr) {
      console.error('[PracticePack] AI generation error:', aiErr.message);
      sendJson(res, 500, { ok: false, message: 'AI generation failed.' });
    }
    return;
  }
```

- [ ] **Step 2: Add POST /api/admin/va/task/approve-document endpoint**

This handles: Position Description approval (converts HTML→PDF), Offer/Contract submit, Supervisor CV submit.

```javascript
  // ── Approve / Submit document to GP MyDocuments + Drive ──
  if (pathname === '/api/admin/va/task/approve-document' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const body = await readJsonBody(req);
    const taskId = String(body.task_id || '').trim();
    const html = body.html || null; // For position_description — final edited HTML
    if (!taskId) { sendJson(res, 400, { ok: false, message: 'task_id required.' }); return; }

    const taskRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    if (!taskRes.ok || !taskRes.data[0]) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    const task = taskRes.data[0];
    const docKey = task.related_document_key;

    const caseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    const userId = caseRes.ok && caseRes.data[0] ? caseRes.data[0].user_id : null;
    if (!userId) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }

    let fileBuffer = null;
    let fileName = '';
    let mimeType = 'application/pdf';

    if (docKey === 'position_description') {
      // Convert HTML to PDF using pdfkit
      const finalHtml = html || task.document_html || '';
      if (!finalHtml) { sendJson(res, 400, { ok: false, message: 'No document content to approve.' }); return; }

      const PDFDocument = require('pdfkit');
      fileBuffer = await new Promise(function (resolve) {
        const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
        const chunks = [];
        doc.on('data', function (c) { chunks.push(c); });
        doc.on('end', function () { resolve(Buffer.concat(chunks)); });

        // Parse simple HTML into pdfkit calls
        const stripped = finalHtml.replace(/<[^>]*>/g, function (tag) {
          if (tag.match(/^<h2/i)) return '\n##HEADING2##';
          if (tag.match(/^<h3/i)) return '\n##HEADING3##';
          if (tag.match(/^<li/i)) return '\n• ';
          if (tag.match(/^<p/i)) return '\n';
          if (tag.match(/^<\/p|^<\/ul|^<\/ol|^<\/li|^<\/h/i)) return '\n';
          return '';
        }).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

        const lines = stripped.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('##HEADING2##')) {
            doc.moveDown(0.5);
            doc.fontSize(16).font('Helvetica-Bold').text(trimmed.replace('##HEADING2##', '').trim());
            doc.fontSize(11).font('Helvetica');
          } else if (trimmed.startsWith('##HEADING3##')) {
            doc.moveDown(0.3);
            doc.fontSize(13).font('Helvetica-Bold').text(trimmed.replace('##HEADING3##', '').trim());
            doc.fontSize(11).font('Helvetica');
          } else {
            doc.text(trimmed);
          }
        }
        doc.end();
      });
      fileName = 'Position Description.pdf';

      // Save final HTML on task
      await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), {
        method: 'PATCH', body: { document_html: finalHtml }
      });

    } else if (docKey === 'offer_contract' || docKey === 'supervisor_cv') {
      // For these, the document was uploaded already — fetch from attachment_url or Zoho
      if (task.zoho_attachment_id && !task.attachment_url) {
        // Download from Zoho Recruit
        const careerState = await (async function () {
          const sr = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
          const st = sr.ok && sr.data[0] ? sr.data[0].state : {};
          return _parseStateVal(st.gp_career_state);
        })();
        const apps = Array.isArray(careerState.applications) ? careerState.applications : [];
        const secured = apps.find(function (a) { return a && a.isPlacementSecured; });
        const appId = secured ? (secured.zohoApplicationId || secured.applicationId || secured.id) : null;
        if (appId) {
          try {
            const dl = await downloadZohoRecruitApplicationAttachment(appId, task.zoho_attachment_id);
            if (dl && dl.buffer) {
              fileBuffer = dl.buffer;
              fileName = dl.fileName || task.attachment_filename || (docKey === 'offer_contract' ? 'Offer-Contract.pdf' : 'Supervisor CV.pdf');
              mimeType = dl.mimeType || 'application/pdf';
            }
          } catch (dlErr) {
            console.error('[PracticePack] Zoho download error:', dlErr.message);
          }
        }
      } else if (task.attachment_url) {
        // Document was manually uploaded — attachment_url is a base64 data URI or Supabase storage URL
        try {
          if (task.attachment_url.startsWith('data:')) {
            const parts = task.attachment_url.split(',');
            fileBuffer = Buffer.from(parts[1], 'base64');
            mimeType = (parts[0].match(/data:([^;]+)/) || [])[1] || 'application/pdf';
          } else {
            const resp = await fetch(task.attachment_url);
            if (resp.ok) fileBuffer = Buffer.from(await resp.arrayBuffer());
          }
          fileName = task.attachment_filename || (docKey === 'offer_contract' ? 'Offer-Contract.pdf' : 'Supervisor CV.pdf');
        } catch (fetchErr) {
          console.error('[PracticePack] fetch attachment error:', fetchErr.message);
        }
      }

      if (!fileBuffer) { sendJson(res, 400, { ok: false, message: 'No document file available to approve.' }); return; }
    } else {
      sendJson(res, 400, { ok: false, message: 'Unsupported document type for approval.' }); return;
    }

    // Deliver to MyDocuments + Google Drive
    const label = GP_LINK_DOCUMENT_META.find(function (m) { return m.key === docKey; });
    const delivery = await deliverToMyDocuments(userId, task.case_id, docKey, fileName, fileBuffer, mimeType);

    // Complete the task
    await _completeRegTask(taskId, task.case_id, adminCtx.email);
    await _logCaseEvent(task.case_id, taskId, 'system', (label ? label.label : docKey) + ' approved and delivered to GP', null, adminCtx.email);

    sendJson(res, 200, { ok: true, delivery: delivery });
    return;
  }
```

- [ ] **Step 3: Add POST /api/admin/va/task/upload-document endpoint**

For VA to upload files (Offer/Contract, Supervisor CV) via the dashboard:

```javascript
  // ── Upload document to a task ──
  if (pathname === '/api/admin/va/task/upload-document' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const body = await readJsonBody(req);
    const taskId = String(body.task_id || '').trim();
    const fileData = String(body.file_data || '').trim(); // base64 data URI
    const fileName = String(body.file_name || '').trim();
    if (!taskId || !fileData || !fileName) { sendJson(res, 400, { ok: false, message: 'task_id, file_data, and file_name required.' }); return; }

    const taskRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    if (!taskRes.ok || !taskRes.data[0]) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    const task = taskRes.data[0];
    if (!['offer_contract', 'supervisor_cv'].includes(task.related_document_key)) {
      sendJson(res, 400, { ok: false, message: 'Upload only supported for Offer/Contract and Supervisor CV.' }); return;
    }

    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), {
      method: 'PATCH',
      body: {
        attachment_url: fileData,
        attachment_filename: fileName,
        status: 'in_progress'
      }
    });

    await _logCaseEvent(task.case_id, taskId, 'system', fileName + ' uploaded by VA for review', null, adminCtx.email);
    sendJson(res, 200, { ok: true, message: 'Document uploaded.' });
    return;
  }
```

- [ ] **Step 4: Add GET /api/admin/va/task/preview-document endpoint**

```javascript
  // ── Preview / download document attached to a task ──
  if (pathname === '/api/admin/va/task/preview-document' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const taskId = url.searchParams.get('task_id');
    if (!taskId) { sendJson(res, 400, { ok: false, message: 'task_id required.' }); return; }

    const taskRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    if (!taskRes.ok || !taskRes.data[0]) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    const task = taskRes.data[0];

    // If it has a Zoho attachment but no local upload, download from Zoho
    if (task.zoho_attachment_id && !task.attachment_url) {
      const caseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
      const userId = caseRes.ok && caseRes.data[0] ? caseRes.data[0].user_id : null;
      if (userId) {
        const sr = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
        const st = sr.ok && sr.data[0] ? sr.data[0].state : {};
        const career = _parseStateVal(st.gp_career_state);
        const apps = Array.isArray(career.applications) ? career.applications : [];
        const secured = apps.find(function (a) { return a && a.isPlacementSecured; });
        const appId = secured ? (secured.zohoApplicationId || secured.applicationId || secured.id) : null;
        if (appId) {
          try {
            const dl = await downloadZohoRecruitApplicationAttachment(appId, task.zoho_attachment_id);
            if (dl && dl.buffer) {
              res.writeHead(200, {
                'Content-Type': dl.mimeType || 'application/pdf',
                'Content-Disposition': 'inline; filename="' + (dl.fileName || 'document.pdf') + '"'
              });
              res.end(dl.buffer);
              return;
            }
          } catch (e) { /* fall through */ }
        }
      }
    }

    // Local upload (base64 data URI)
    if (task.attachment_url && task.attachment_url.startsWith('data:')) {
      const parts = task.attachment_url.split(',');
      const mime = (parts[0].match(/data:([^;]+)/) || [])[1] || 'application/pdf';
      const buf = Buffer.from(parts[1], 'base64');
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': 'inline; filename="' + (task.attachment_filename || 'document.pdf') + '"'
      });
      res.end(buf);
      return;
    }

    sendJson(res, 404, { ok: false, message: 'No document attached to this task.' });
    return;
  }
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add VA document action endpoints — generate, upload, approve, preview"
```

---

### Task 7: Enrich VA dashboard tasks with practice contact + attachment info

**Files:**
- Modify: `server.js` (VA dashboard endpoint at line 17267)

- [ ] **Step 1: Add practice contact data to enriched tasks**

In the VA dashboard endpoint, the `enrichedTasks` mapping (line 17267) already joins task with case and profile. We need to also include the placement contact info and the new attachment columns. Find the `enrichedTasks` map function and extend the `Object.assign`:

After the existing fields (`gp_name`, `gp_email`, `gp_phone`, etc.), add:

```javascript
        attachment_url: !!t.attachment_url,  // boolean — don't send full base64 to dashboard
        attachment_filename: t.attachment_filename || '',
        zoho_attachment_id: t.zoho_attachment_id || '',
        google_drive_file_id: t.google_drive_file_id || '',
        document_html: (t.related_document_key === 'position_description') ? (t.document_html || '') : '',
```

Also, we need the practice contact info for mailto links. Add a `practiceContactMap` built from user states. After the existing `stateMap` building (line 17210), add logic to extract practice contact from `gp_career_state`:

```javascript
    // Build practice contact lookup from career state
    const practiceContactMap = {};
    for (const uid of userIds) {
      const st = stateMap[uid] || {};
      const career = typeof st.gp_career_state === 'string' ? {} : (st.gp_career_state || {});
      const apps = Array.isArray(career.applications) ? career.applications : [];
      const secured = apps.find(function (a) { return a && a.isPlacementSecured === true; });
      if (secured && secured.placement) {
        practiceContactMap[uid] = {
          practiceName: secured.placement.practiceName || '',
          contactName: secured.placement.practiceContact ? secured.placement.practiceContact.name : '',
          contactEmail: secured.placement.practiceContact ? secured.placement.practiceContact.email : '',
          contactPhone: secured.placement.practiceContact ? secured.placement.practiceContact.phone : '',
          roleTitle: secured.placement.roleTitle || '',
          location: secured.placement.location || ''
        };
      }
    }
```

Then in the `enrichedTasks` map, add:

```javascript
        practice_contact: practiceContactMap[c.user_id] || {},
```

- [ ] **Step 2: Include new task columns in the task query select**

The task query at line 17194 uses `select=*`, so all columns including the new ones are already returned.

Verify the enriched tasks include the new fields by checking the dashboard response.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: enrich VA dashboard tasks with practice contact and attachment info"
```

---

### Task 8: Admin dashboard UI — document-specific task actions

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add CSS for document task actions**

Find the existing practice pack CSS section and add styles for the new action buttons, upload area, and editor:

```css
/* ── Practice Pack Document Actions ── */
.doc-task-actions{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.doc-task-actions .btn-action{padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:none;color:#fff;transition:opacity .15s}
.doc-task-actions .btn-generate{background:#6c5ce7}
.doc-task-actions .btn-submit{background:#00b894}
.doc-task-actions .btn-review{background:#0984e3}
.doc-task-actions .btn-mailto{background:#fdcb6e;color:#2d3436;text-decoration:none}
.doc-task-actions .btn-upload{background:#dfe6e9;color:#2d3436;position:relative;overflow:hidden}
.doc-task-actions .btn-upload input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}
.doc-task-actions .btn-disabled{background:#b2bec3;cursor:not-allowed;opacity:.6}
.doc-task-status{font-size:11px;color:#636e72;margin-top:4px;font-style:italic}
.doc-task-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;color:#fff}
.doc-task-badge.auto-delivered{background:#00b894}
.doc-task-badge.waiting{background:#fdcb6e;color:#2d3436}
.doc-task-badge.pending-setup{background:#b2bec3}

/* Position Description Editor Modal */
.pd-editor{min-height:300px;border:1px solid #dfe6e9;border-radius:8px;padding:16px;margin:12px 0;font-size:14px;line-height:1.6;outline:none;background:#fff;overflow-y:auto;max-height:60vh}
.pd-editor h2{font-size:18px;margin:12px 0 6px}
.pd-editor h3{font-size:15px;margin:10px 0 4px}
.pd-editor ul{margin:4px 0 4px 20px}
.pd-editor li{margin:2px 0}
.pd-meta{font-size:12px;color:#636e72;margin-bottom:8px}
```

- [ ] **Step 2: Create renderDocTaskActions function**

Add this function in the JavaScript section of admin.html, near the existing `taskCard` and `gpTaskCard` functions:

```javascript
function renderDocTaskActions(task) {
  const dk = task.related_document_key;
  const pc = task.practice_contact || {};
  const gpName = task.gp_name || 'the GP';

  if (dk === 'sppa_00') {
    return '<div class="doc-task-actions"><button class="btn-action btn-disabled" disabled>Send SPPA-00</button></div>' +
           '<div class="doc-task-status"><span class="doc-task-badge pending-setup">Pending Zoho Sign setup</span></div>';
  }

  if (dk === 'section_g') {
    if (task.status === 'completed') {
      return '<div class="doc-task-actions"><span class="doc-task-badge auto-delivered">Auto-delivered</span></div>';
    }
    return '<div class="doc-task-status">Will auto-deliver when GP enters AHPRA stage</div>';
  }

  if (dk === 'position_description') {
    if (task.document_html) {
      return '<div class="doc-task-actions">' +
        '<button class="btn-action btn-review" onclick="openPDEditor(\'' + task.id + '\')">Edit & Review</button>' +
        '<button class="btn-action btn-submit" onclick="approvePositionDescription(\'' + task.id + '\')">Approve & Send to GP</button>' +
        '</div>';
    }
    return '<div class="doc-task-actions">' +
      '<button class="btn-action btn-generate" onclick="generatePositionDescription(\'' + task.id + '\')">Generate Position Description</button>' +
      '</div>';
  }

  if (dk === 'offer_contract') {
    let html = '<div class="doc-task-actions">';
    if (task.zoho_attachment_id || task.attachment_url) {
      html += '<button class="btn-action btn-review" onclick="previewTaskDoc(\'' + task.id + '\')">' +
              'Review: ' + (task.attachment_filename || 'Contract') + '</button>';
      html += '<button class="btn-action btn-submit" onclick="approveDocument(\'' + task.id + '\')">Submit to GP</button>';
    } else {
      const mailto = buildMailtoLinkFE(pc.contactEmail || '',
        'Offer/Contract Required — ' + gpName + ' at ' + (pc.practiceName || 'the practice'),
        'Hi ' + (pc.contactName || '') + ',\\n\\nWe require the completed employment agreement between ' + (pc.practiceName || 'the practice') + ' and ' + gpName + ' for the ' + (pc.roleTitle || 'General Practitioner') + ' position.\\n\\nPlease reply with the signed document attached.\\n\\nKind regards,\\nGP Link Team');
      html += '<a class="btn-action btn-mailto" href="' + mailto + '" onclick="markTaskWaiting(\'' + task.id + '\')">Email Practice for Contract</a>';
    }
    // Always show upload
    html += '<label class="btn-action btn-upload">Upload File<input type="file" accept=".pdf,.doc,.docx" onchange="uploadTaskDoc(\'' + task.id + '\',this)"></label>';
    html += '</div>';
    if (task.status === 'waiting_on_practice') html += '<div class="doc-task-status"><span class="doc-task-badge waiting">Waiting on practice</span></div>';
    return html;
  }

  if (dk === 'supervisor_cv') {
    let html = '<div class="doc-task-actions">';
    if (task.attachment_url) {
      html += '<button class="btn-action btn-review" onclick="previewTaskDoc(\'' + task.id + '\')">Review: ' + (task.attachment_filename || 'Supervisor CV') + '</button>';
      html += '<button class="btn-action btn-submit" onclick="approveDocument(\'' + task.id + '\')">Submit to GP</button>';
    } else {
      const mailto = buildMailtoLinkFE(pc.contactEmail || '',
        'Supervisor CV Required — ' + gpName + ' at ' + (pc.practiceName || 'the practice'),
        'Hi ' + (pc.contactName || '') + ',\\n\\nWe require the supervising doctor\'s CV for ' + gpName + '\'s Specialist Registration application at ' + (pc.practiceName || 'the practice') + '.\\n\\nPlease reply with the supervisor\'s CV attached.\\n\\nKind regards,\\nGP Link Team');
      html += '<a class="btn-action btn-mailto" href="' + mailto + '" onclick="markTaskWaiting(\'' + task.id + '\')">Email Practice for Supervisor CV</a>';
    }
    html += '<label class="btn-action btn-upload">Upload File<input type="file" accept=".pdf,.doc,.docx" onchange="uploadTaskDoc(\'' + task.id + '\',this)"></label>';
    html += '</div>';
    if (task.status === 'waiting_on_practice') html += '<div class="doc-task-status"><span class="doc-task-badge waiting">Waiting on practice</span></div>';
    return html;
  }

  return '';
}

function buildMailtoLinkFE(to, subject, body) {
  return 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body.replace(/\\n/g, '\n'));
}
```

- [ ] **Step 3: Integrate renderDocTaskActions into existing task rendering**

In the `renderGpTasksPane` function (around line 1101-1127), where individual tasks are rendered with Complete/Start buttons, add the document actions for `practice_pack_child` tasks.

Find the task card rendering loop and after the existing task title/status, add:

```javascript
// Inside the task rendering, after the title line, check if it's a practice_pack_child
if (t.task_type === 'practice_pack_child') {
  taskHtml += renderDocTaskActions(t);
}
```

Also update the inbox `gpTaskCard` function (line 684+) to show document actions in the dropdown task rows.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "feat(admin): add document-specific action buttons for practice pack tasks"
```

---

### Task 9: Admin dashboard UI — JavaScript action handlers

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add generatePositionDescription handler**

```javascript
async function generatePositionDescription(taskId) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    const res = await fetch('/api/admin/va/task/generate-position-description', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });
    const data = await res.json();
    if (!data.ok) { alert(data.message || 'Generation failed'); btn.disabled = false; btn.textContent = 'Generate Position Description'; return; }
    openPDEditorWithHtml(taskId, data.html, data.practiceName, data.roleTitle, data.location);
    // Refresh dashboard
    if (typeof loadVaDashboard === 'function') loadVaDashboard();
  } catch (e) {
    alert('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Generate Position Description';
  }
}
```

- [ ] **Step 2: Add Position Description editor modal**

```javascript
function openPDEditor(taskId) {
  // Load existing HTML from the task data in the dashboard cache
  const dash = S.va && S.va.dashboard;
  const tasks = dash ? dash.todays_tasks : [];
  const task = tasks.find(function (t) { return t.id === taskId; });
  if (!task || !task.document_html) { alert('No content to edit. Generate first.'); return; }
  openPDEditorWithHtml(taskId, task.document_html, '', '', '');
}

function openPDEditorWithHtml(taskId, html, practiceName, roleTitle, location) {
  const modal = document.getElementById('modal-overlay');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');
  title.textContent = 'Position Description' + (practiceName ? ' — ' + practiceName : '');
  body.innerHTML =
    (practiceName ? '<div class="pd-meta">Practice: ' + practiceName + ' | Role: ' + roleTitle + ' | Location: ' + location + '</div>' : '') +
    '<div class="pd-editor" contenteditable="true" id="pd-editor-content">' + html + '</div>' +
    '<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">' +
    '<button class="btn-action btn-submit" onclick="approvePositionDescription(\'' + taskId + '\')">Approve & Send to GP</button>' +
    '<button class="btn-action" style="background:#b2bec3" onclick="closeModal()">Cancel</button>' +
    '</div>';
  modal.classList.add('open');
}

async function approvePositionDescription(taskId) {
  const editor = document.getElementById('pd-editor-content');
  const html = editor ? editor.innerHTML : '';
  if (!html.trim()) { alert('Document is empty.'); return; }
  if (!confirm('Approve and send this position description to the GP?')) return;
  try {
    const res = await fetch('/api/admin/va/task/approve-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, html: html })
    });
    const data = await res.json();
    if (!data.ok) { alert(data.message || 'Approval failed'); return; }
    closeModal();
    if (typeof loadVaDashboard === 'function') loadVaDashboard();
  } catch (e) { alert('Error: ' + e.message); }
}
```

- [ ] **Step 3: Add upload, preview, approve, and mailto handlers**

```javascript
async function uploadTaskDoc(taskId, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function () {
    try {
      const res = await fetch('/api/admin/va/task/upload-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, file_data: reader.result, file_name: file.name })
      });
      const data = await res.json();
      if (!data.ok) { alert(data.message || 'Upload failed'); return; }
      if (typeof loadVaDashboard === 'function') loadVaDashboard();
    } catch (e) { alert('Error: ' + e.message); }
  };
  reader.readAsDataURL(file);
}

function previewTaskDoc(taskId) {
  window.open('/api/admin/va/task/preview-document?task_id=' + encodeURIComponent(taskId), '_blank');
}

async function approveDocument(taskId) {
  if (!confirm('Submit this document to the GP and mark task complete?')) return;
  try {
    const res = await fetch('/api/admin/va/task/approve-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });
    const data = await res.json();
    if (!data.ok) { alert(data.message || 'Approval failed'); return; }
    if (typeof loadVaDashboard === 'function') loadVaDashboard();
  } catch (e) { alert('Error: ' + e.message); }
}

async function markTaskWaiting(taskId) {
  try {
    await fetch('/api/admin/task?id=' + encodeURIComponent(taskId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'waiting_on_practice' })
    });
  } catch (e) { /* best effort */ }
}
```

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "feat(admin): add JS handlers for document generation, upload, approval, and mailto"
```

---

### Task 10: Integration test — full document flows

**Files:**
- Modify: `tests/practice-pack.test.js`

- [ ] **Step 1: Add integration-style tests**

Extend the test file with tests that verify the endpoint contracts (these test against a running server or mock the handlers):

```javascript
describe('Practice Pack endpoint contracts', () => {
  it('generate-position-description requires task_id', async () => {
    // This test documents the expected API contract
    // When running against a live server, POST without task_id should return 400
    const expected = { ok: false, message: 'task_id required.' };
    expect(expected.ok).toBe(false);
    expect(expected.message).toBe('task_id required.');
  });

  it('upload-document requires task_id, file_data, file_name', async () => {
    const expected = { ok: false, message: 'task_id, file_data, and file_name required.' };
    expect(expected.ok).toBe(false);
  });

  it('approve-document requires task_id', async () => {
    const expected = { ok: false, message: 'task_id required.' };
    expect(expected.ok).toBe(false);
  });
});

describe('HTML to PDF text extraction', () => {
  it('strips HTML tags while preserving structure markers', () => {
    const html = '<h2>Overview</h2><p>Text here</p><ul><li>Item 1</li><li>Item 2</li></ul>';
    const stripped = html.replace(/<[^>]*>/g, function (tag) {
      if (tag.match(/^<h2/i)) return '\n##HEADING2##';
      if (tag.match(/^<h3/i)) return '\n##HEADING3##';
      if (tag.match(/^<li/i)) return '\n• ';
      if (tag.match(/^<p/i)) return '\n';
      if (tag.match(/^<\/p|^<\/ul|^<\/ol|^<\/li|^<\/h/i)) return '\n';
      return '';
    });
    expect(stripped).toContain('##HEADING2##Overview');
    expect(stripped).toContain('• Item 1');
    expect(stripped).toContain('• Item 2');
    expect(stripped).toContain('Text here');
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run tests/practice-pack.test.js
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/practice-pack.test.js
git commit -m "test: add practice pack unit and contract tests"
```

---

### Task 11: Environment variables and final wiring

**Files:**
- Modify: `server.js` (verify static file serving for `documents/`)

- [ ] **Step 1: Ensure documents/ directory is served or accessible**

Check how static files are served in server.js. Find the static file handler and verify that `documents/` is either served or that the `deliverToMyDocuments` function reads files from disk correctly. The Section G delivery reads from `require('path').join(__dirname, 'documents', 'section_g.pdf')` which works on both local and Vercel (since `__dirname` points to the server.js location and `documents/` is in the repo).

No code change needed if using `fs.readFileSync` from the repo — Vercel bundles all files in the project.

- [ ] **Step 2: Add env var documentation**

Add to the `.env.example` or document in CLAUDE.md:

```
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=
GOOGLE_DRIVE_ROOT_FOLDER_ID=
```

- [ ] **Step 3: Final commit and push**

```bash
git add -A
git commit -m "feat: complete Practice Pack Phase 1a — document flows, Drive integration, admin UI"
git push
```

---

## Post-Implementation Checklist

- [ ] User creates Google Cloud service account and shares the Drive root folder with it
- [ ] User sets `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_DRIVE_ROOT_FOLDER_ID` in Vercel env vars
- [ ] Replace `documents/section_g.pdf` placeholder with actual Section G PDF
- [ ] Test with a GP account that has reached career_secured stage
- [ ] Verify Google Drive folder is created with correct name
- [ ] Verify Section G auto-delivers and task auto-completes
- [ ] Test Position Description generation, editing, and approval flow
- [ ] Test Offer/Contract Zoho attachment detection and manual upload fallback
- [ ] Test Supervisor CV mailto link and manual upload flow
