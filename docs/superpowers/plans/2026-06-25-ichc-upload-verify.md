# Fit2Work ICHC Upload & Verify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the typed Fit2Work reference-number box (My Documents → Direct to AHPRA) with an upload control whose file the AI verifies as a genuine ICHC reference page, auto-extracts the FIT number, saves the document, blocks the example, and surfaces consistently in the AHPRA gateway.

**Architecture:** A new `lib/ichc-verify.js` holds the pure, unit-tested logic (reference-number parsing + example detection by reference number and by file SHA-256). A new server endpoint `POST /api/ai/verify-ichc` mirrors the existing `/api/ai/verify-certification` flow (auth, budget, daily limit, PDF/image content blocks), calls Anthropic vision to verify + extract, blocks the example, saves verified pages to `user_documents` via `savePreparedDocumentForUser`, and on the 3rd failed attempt saves for manual review via `ensureDocReviewOnUpload`. The two client pages (`my-documents.html`, `ahpra.html`) swap the text input for an upload + show the redacted example in "Show me how" + surface the saved doc in the AHPRA download pack.

**Tech Stack:** Node.js (vanilla `http` server, single `server.js`), plain HTML/inline-JS pages, Supabase (`user_documents` + storage), Anthropic vision API, vitest.

## Global Constraints

- **Base / source of truth:** the git worktree `worktree-ichc-upload-verify` (branched from `origin/main` = cc7902f, the live production code). All edits happen in the worktree. Locate code by the grep anchors below, not fixed line numbers.
- **Anthropic model:** use the existing `ANTHROPIC_MODEL` constant — never hardcode a model id. Do **not** send a `temperature` param (the pinned Opus model rejects it — see memory `anthropic-model-id-pinning`).
- **User-facing copy:** plain, everyday English (the owner is non-technical; GPs are the audience). No jargon.
- **Reference number format:** `FIT` + exactly 7 digits (regex `/^FIT\d{7}$/`).
- **Example fingerprints (block, never save):** reference numbers `FIT1234567` and `FIT7623801`; file SHA-256 `c176ad9cc310f83267b6c0f5ca24f4525aebece7ef328be19f3771683d9f81e2` (redacted) and `3dea2e94a2179d954a1b58750014e49094d3423f207a6c913d119bead6751cc8` (original).
- **Example asset:** already staged at `documents/fit2work-ichc-example.pdf` (served at `/documents/fit2work-ichc-example.pdf`, like `/documents/section_g.pdf`). Commit it.
- **localStorage keys (unchanged, canonical for display):** `gp_documents_prep` (`DOC_KEY`) → `.docs.criminal_history.{referenceNumber,url,status,uploaded,fileName}`; plus `gp_amc_progress.criminalHistoryRef`.
- **Verification gates:** `node --check server.js` must pass; full `vitest run` must stay green (596 baseline).
- Run node/vitest with: `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH"` and `node node_modules/vitest/vitest.mjs run`.

---

### Task 1: Pure ICHC logic + unit tests (`lib/ichc-verify.js`)

**Files:**
- Create: `lib/ichc-verify.js`
- Test: `tests/ichc-verify.test.js`

**Interfaces:**
- Produces (consumed by Task 2):
  - `normalizeIchcReference(raw: string): string|null` — finds `FIT` + 7 digits in arbitrary text (case-insensitive, tolerates a space/dash after `FIT`), returns canonical uppercase `FIT#######`, else `null`.
  - `isValidIchcReference(ref: string): boolean` — `/^FIT\d{7}$/`.
  - `sha256Hex(buf: Buffer): string` — lowercase hex digest.
  - `isExampleIchcReference(ref: string): boolean` — true if normalized ref ∈ example refs.
  - `isExampleIchcFile(buf: Buffer): boolean` — true if `sha256Hex(buf)` ∈ example hashes.
  - `EXAMPLE_ICHC_REFERENCES: string[]`, `EXAMPLE_ICHC_FILE_SHA256: string[]`.

- [ ] **Step 1: Write the failing test** — `tests/ichc-verify.test.js`

```js
import { describe, it, expect } from 'vitest';
import {
  normalizeIchcReference, isValidIchcReference, sha256Hex,
  isExampleIchcReference, isExampleIchcFile,
  EXAMPLE_ICHC_REFERENCES, EXAMPLE_ICHC_FILE_SHA256,
} from '../lib/ichc-verify.js';

describe('normalizeIchcReference', () => {
  it('extracts and canonicalises a reference from messy text', () => {
    expect(normalizeIchcReference('Check ReferenceNumber FIT7623801')).toBe('FIT7623801');
    expect(normalizeIchcReference('fit 1234567')).toBe('FIT1234567');
    expect(normalizeIchcReference('FIT-7654321 done')).toBe('FIT7654321');
  });
  it('returns null when there is no valid reference', () => {
    expect(normalizeIchcReference('no number here')).toBeNull();
    expect(normalizeIchcReference('FIT123')).toBeNull();      // too short
    expect(normalizeIchcReference('')).toBeNull();
    expect(normalizeIchcReference(null)).toBeNull();
  });
});

describe('isValidIchcReference', () => {
  it('accepts FIT + 7 digits only', () => {
    expect(isValidIchcReference('FIT0000001')).toBe(true);
    expect(isValidIchcReference('FIT123456')).toBe(false);
    expect(isValidIchcReference('XIT1234567')).toBe(false);
  });
});

describe('example detection', () => {
  it('flags the example reference numbers', () => {
    expect(isExampleIchcReference('FIT1234567')).toBe(true);
    expect(isExampleIchcReference('fit7623801')).toBe(true);
    expect(isExampleIchcReference('FIT7654321')).toBe(false);
    expect(EXAMPLE_ICHC_REFERENCES).toContain('FIT1234567');
  });
  it('flags the example files by sha256', () => {
    const exampleBuf = Buffer.from('x');
    expect(isExampleIchcFile(exampleBuf)).toBe(false);
    EXAMPLE_ICHC_FILE_SHA256.forEach((h) => expect(h).toMatch(/^[0-9a-f]{64}$/));
    // sha256 of known bytes is stable:
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH" && node node_modules/vitest/vitest.mjs run tests/ichc-verify.test.js`
Expected: FAIL — `Cannot find module '../lib/ichc-verify.js'`.

- [ ] **Step 3: Write minimal implementation** — `lib/ichc-verify.js`

```js
'use strict';
const crypto = require('crypto');

const EXAMPLE_ICHC_REFERENCES = ['FIT1234567', 'FIT7623801'];
const EXAMPLE_ICHC_FILE_SHA256 = [
  'c176ad9cc310f83267b6c0f5ca24f4525aebece7ef328be19f3771683d9f81e2', // redacted sample
  '3dea2e94a2179d954a1b58750014e49094d3423f207a6c913d119bead6751cc8', // original (real PII)
];

function normalizeIchcReference(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/FIT[\s-]?(\d{7})(?!\d)/i);
  return m ? 'FIT' + m[1] : null;
}
function isValidIchcReference(ref) {
  return typeof ref === 'string' && /^FIT\d{7}$/.test(ref);
}
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function isExampleIchcReference(ref) {
  const norm = normalizeIchcReference(ref) || (typeof ref === 'string' ? ref.toUpperCase() : '');
  return EXAMPLE_ICHC_REFERENCES.includes(norm);
}
function isExampleIchcFile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  return EXAMPLE_ICHC_FILE_SHA256.includes(sha256Hex(buf));
}

module.exports = {
  EXAMPLE_ICHC_REFERENCES, EXAMPLE_ICHC_FILE_SHA256,
  normalizeIchcReference, isValidIchcReference, sha256Hex,
  isExampleIchcReference, isExampleIchcFile,
};
```

Note: tests use ESM `import` from a CommonJS module — vitest handles this interop (existing `lib/file-sanitise.js` is required the same way; confirm the import style other `tests/*.test.js` use and match it).

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ichc-verify.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/ichc-verify.js tests/ichc-verify.test.js
git commit -m "Add ICHC reference parsing + example-detection helpers (tested)"
```

---

### Task 2: Server endpoint `POST /api/ai/verify-ichc`

**Files:**
- Modify: `server.js` — add `require('./lib/ichc-verify')` near the other top-level `require(...)` of `lib/` modules; add the endpoint immediately after the `/api/ai/verify-certification` block.

**Interfaces:**
- Consumes (Task 1): all of `lib/ichc-verify.js`.
- Reuses existing server helpers (confirm names by grep in worktree `server.js`): `requireSession`, `getSessionEmail`, `getSessionSupabaseUserId`, `getSupabaseUserIdByEmail`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `checkAnthropicBudget`, `checkUserAiLimit`, `recordAnthropicSpend`, `recordUserAiCall`, `MAX_IMAGE_BASE64_LENGTH`, `normalizeImageForAi`, `stripBase64DataUrlPrefix`, `validateFileUpload`, `savePreparedDocumentForUser`, `ensureDocReviewOnUpload`, `supabaseDbRequest`, `sendJson`, `readJsonBody`, `sanitizeUserString`, `isSupabaseDbConfigured`.
- Produces (consumed by Task 3, the client):
  - Verified: `{ ok:true, verified:true, referenceNumber:"FIT#######", applicantName:string|null, document:{ downloadUrl, fileName, status } }`
  - Example: `{ ok:true, verified:false, isExample:true, message:string }`
  - Unverified, not final: `{ ok:true, verified:false, issues:string[] }`
  - Unverified, final (3rd attempt): `{ ok:true, verified:false, manualReview:true, document:{...} }`

- [ ] **Step 1: Add the require** — near other `const { ... } = require('./lib/...')` lines at the top of `server.js`:

```js
const {
  normalizeIchcReference, isValidIchcReference,
  isExampleIchcReference, isExampleIchcFile,
} = require('./lib/ichc-verify');
```

- [ ] **Step 2: Add the endpoint.** Grep anchor: find the end of the `/api/ai/verify-certification` handler (search `pathname === '/api/ai/verify-certification'`, then its closing `return; }`). Insert this block right after it. Match the surrounding style of the cert handler for budget/limit/content-block handling.

```js
  /* ── AI ICHC (Fit2Work criminal-history reference page) verify + extract + save ── */
  if (pathname === '/api/ai/verify-ichc' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    if (!ANTHROPIC_API_KEY) { sendJson(res, 503, { ok:false, message:'AI verification service not configured.' }); return; }
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok:false, message:'Document storage is not configured.' }); return; }

    const ichcEmail = getSessionEmail(session);
    if (ichcEmail && !checkUserAiLimit(ichcEmail)) {
      sendJson(res, 429, { ok:false, message:'You have reached the maximum number of verification attempts today. Please try again tomorrow.' });
      return;
    }

    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok:false, message:'Invalid request body.' }); return; }
    const { imageBase64, mimeType } = body || {};
    const country = sanitizeUserString(body.country, 8) || 'uk';
    const finalAttempt = body.finalAttempt === true;
    const fileName = sanitizeUserString(body.fileName, 200) || 'fit2work-ichc.pdf';
    if (!imageBase64) { sendJson(res, 400, { ok:false, message:'Missing required field: imageBase64.' }); return; }
    if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) { sendJson(res, 413, { ok:false, message:'File too large. Maximum size is 15MB.' }); return; }

    // Raw bytes for hashing + storage + validation
    const rawBase64 = stripBase64DataUrlPrefix(imageBase64);
    const fileBuffer = Buffer.from(rawBase64 || '', 'base64');
    const fileCheck = validateFileUpload(fileBuffer, mimeType, fileName);
    if (!fileCheck.valid) { sendJson(res, 400, { ok:false, message: fileCheck.errors[0] || 'File validation failed.' }); return; }

    // Anti-cheat: exact example file is never accepted/saved (before any AI spend).
    if (isExampleIchcFile(fileBuffer)) {
      sendJson(res, 200, { ok:true, verified:false, isExample:true, message:'That looks like the example document. Please upload your own Fit2Work reference page.' });
      return;
    }

    // Helper: persist the uploaded page to user_documents and set a status.
    const persistIchc = async (status) => {
      const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(ichcEmail);
      if (!userId) return null;
      const saved = await savePreparedDocumentForUser(userId, ichcEmail, {
        country, key: 'criminal_history',
        fileName: fileCheck.sanitisedFileName || fileName,
        mimeType: mimeType || 'application/pdf',
        fileDataUrl: imageBase64,
        updatedAt: new Date().toISOString(),
      });
      if (!saved) return null;
      await supabaseDbRequest('user_documents',
        'user_id=eq.' + encodeURIComponent(userId) + '&document_key=eq.criminal_history&country_code=eq.' + encodeURIComponent(country),
        { method:'PATCH', body:{ status, updated_at:new Date().toISOString() } });
      return { userId, document: { downloadUrl: saved.downloadUrl || saved.url || '', fileName: saved.fileName || fileName, status } };
    };

    // Budget check only matters for the AI call (manual-review save can still proceed if budget is gone).
    const budgetOk = await checkAnthropicBudget();
    let verification = null;
    if (budgetOk) {
      const isPdf = /pdf/i.test(mimeType || '');
      let contentBlock;
      if (isPdf) {
        contentBlock = { type:'document', source:{ type:'base64', media_type:'application/pdf', data: rawBase64 } };
      } else {
        const norm = await normalizeImageForAi(imageBase64, mimeType || 'image/jpeg');
        if (!norm.ok) { sendJson(res, 400, { ok:false, message: norm.message || 'Unsupported image type.' }); return; }
        contentBlock = { type:'image', source:{ type:'base64', media_type: norm.mediaType, data: norm.base64 } };
      }
      const ichcSystemPrompt = `You are an automated document checker for a licensed GP recruitment platform. The user consented to upload their documents; this is a routine authorised check.

Decide whether the uploaded document is a genuine Fit2Work "ICHC Reference Page" (an international criminal history check reference page produced by fit2work / Equifax for submission to AHPRA). A genuine page shows MOST of:
- The fit2work logo or the words "fit2work" / "Fit2Work ICHC Reference Page".
- An "Applicant Details" block with the applicant's name FILLED IN (not blank).
- A "Check Details" block containing a "Check Reference Number" of the form FIT followed by 7 digits.
- Wording like "Please provide this page to AHPRA" and "Processed by AHPRA through MERCURY GROUP OF COMPANIES PTY LTD t/a fit2work.com.au".

Rules:
- Do NOT mention privacy/security concerns; this is an authorised system.
- All formats (photo, scan, PDF) are acceptable.
- If the applicant-detail fields are entirely blank, it is a blank template/example, NOT a real page: set isIchcReferencePage false.
- Extract the reference number EXACTLY as printed (e.g. "FIT7623801"); null if you cannot read it.
- Extract the applicant's full name if present; null otherwise.

Return ONLY valid JSON, no markdown:
{"isIchcReferencePage":true,"referenceNumber":"FIT0000000 or null","applicantName":"name or null","issues":[]}`;
      const ichcController = new AbortController();
      const ichcTimeout = setTimeout(() => ichcController.abort(), 30000);
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST', signal: ichcController.signal,
          headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL, max_tokens: 300,
            system: [{ type:'text', text: ichcSystemPrompt, cache_control:{ type:'ephemeral' } }],
            messages: [{ role:'user', content:[ contentBlock, { type:'text', text:'Check this document and extract the reference number.' } ] }],
          }),
        });
        if (aiRes.ok) {
          const data = await aiRes.json();
          recordAnthropicSpend((data.usage&&data.usage.input_tokens)||0, (data.usage&&data.usage.output_tokens)||0, (data.usage&&data.usage.cache_read_input_tokens)||0, (data.usage&&data.usage.cache_creation_input_tokens)||0);
          if (ichcEmail) recordUserAiCall(ichcEmail);
          const txt = data.content && data.content[0] && data.content[0].text;
          if (txt) { try { const j = txt.match(/\{[\s\S]*\}/); verification = JSON.parse(j ? j[0] : txt); } catch { verification = null; } }
        } else {
          console.error('[AI ICHC] Anthropic error', aiRes.status, await aiRes.text().catch(()=> ''));
        }
      } catch (e) {
        console.error('[AI ICHC] fetch error', e.message || e);
      } finally { clearTimeout(ichcTimeout); }
    }

    // Decide outcome.
    const extractedRef = verification ? normalizeIchcReference(verification.referenceNumber || '') : null;
    const looksGenuine = !!(verification && verification.isIchcReferencePage && isValidIchcReference(extractedRef));

    // Anti-cheat: example reference numbers are never accepted/saved.
    if (extractedRef && isExampleIchcReference(extractedRef)) {
      sendJson(res, 200, { ok:true, verified:false, isExample:true, message:'That looks like the example document. Please upload your own Fit2Work reference page.' });
      return;
    }

    if (looksGenuine) {
      const saved = await persistIchc('accepted');
      if (!saved) { sendJson(res, 502, { ok:false, message:'We could not save your document. Please try again.' }); return; }
      sendJson(res, 200, { ok:true, verified:true, referenceNumber: extractedRef, applicantName: (verification.applicantName || null), document: saved.document });
      return;
    }

    // Not verified.
    if (finalAttempt) {
      const saved = await persistIchc('under_review');
      if (!saved) { sendJson(res, 502, { ok:false, message:'We could not save your document. Please try again.' }); return; }
      await ensureDocReviewOnUpload(saved.userId, 'criminal_history', 'Fit2Work ICHC Reference Page', 'ahpra').catch((e)=>console.error('[AI ICHC] review task error', e.message));
      sendJson(res, 200, { ok:true, verified:false, manualReview:true, document: saved.document });
      return;
    }
    const issues = (verification && Array.isArray(verification.issues) && verification.issues.length)
      ? verification.issues
      : ['This does not look like a Fit2Work ICHC reference page, or the reference number could not be read.'];
    sendJson(res, 200, { ok:true, verified:false, issues });
    return;
  }
```

- [ ] **Step 3: Syntax check**

Run: `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH" && node --check server.js`
Expected: no output (exit 0). If `ensureDocReviewOnUpload`'s 4th arg (reviewStage) is not `'ahpra'` in this codebase, grep its definition + an existing call and pass the value those use (or `undefined`).

- [ ] **Step 4: Confirm the suite still passes**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: all green (596 + Task 1's new tests).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "Add /api/ai/verify-ichc: verify, extract FIT number, save, block example, 3-fail manual review"
```

---

### Task 3: My Documents — upload + verify UI (`pages/my-documents.html`)

**Files:**
- Modify: `pages/my-documents.html`

**Interfaces:**
- Consumes (Task 2): `POST /api/ai/verify-ichc`.
- Reuses existing in-file helpers (confirm by grep): `readFileAsDataUrl`, `showCertResultPopup`, `getFriendlyScanMessageHtml`, `persistDocsState`, `renderAll`, `applyStoredFile`, `getCertFailCount`/`incCertFailCount`/`resetCertFailCount` (the `certFailCounts` mechanism), `escapeHtml`, `isAiScannableFile`, `getCountryConfig`, `COUNTRY_DOCS`.

- [ ] **Step 1: Add the example link to the `criminal_history` help.** Grep anchor: in `COUNTRY_DOCS` (3 occurrences of `key: "criminal_history"`), each has a `help.steps` array ending with the "...starting with **FIT** followed by 7 digits..." string OR just the Fit2Work link. Right after `const COUNTRY_DOCS = {...};` is fully defined, add a one-time normaliser so all three stay DRY:

```js
    // Show the redacted sample page in "Show me how" for the Fit2Work step.
    var ICHC_EXAMPLE_STEP_HTML = 'See what the page looks like: <a href="/documents/fit2work-ichc-example.pdf" target="_blank" rel="noopener noreferrer">view a sample Fit2Work ICHC reference page</a>. This is only an example — you must upload your own page, not this sample.';
    Object.keys(COUNTRY_DOCS).forEach(function (c) {
      (COUNTRY_DOCS[c].institution || []).forEach(function (d) {
        if (d.key === 'criminal_history' && d.help && Array.isArray(d.help.steps)
            && d.help.steps.indexOf(ICHC_EXAMPLE_STEP_HTML) === -1) {
          d.help.steps = d.help.steps
            .map(function (s) { return /Enter this reference number below/.test(s)
              ? 'When your check is complete, Fit2Work emails you a <strong>reference page</strong> (PDF). Download it and upload it below — our system reads your <strong>FIT</strong> number from it automatically.' : s; })
            .concat([ICHC_EXAMPLE_STEP_HTML]);
        }
      });
    });
```

- [ ] **Step 2: Replace the typed-input card markup with an upload control.** Grep anchor: the `if (item.key === 'criminal_history') {` block that builds `refNumHtml` with the `criminal-ref-input` text field and `criminal-ref-save` button. Replace that whole `refNumHtml` block so the card shows: (a) when no verified ref → an Upload button; (b) when a verified ref exists → the read-only number + uploaded file name + Re-upload. Use the existing `itemState` (now carrying `referenceNumber`, `url`, `status`, `fileName`).

```js
        var refNumHtml = '';
        if (item.key === 'criminal_history') {
          var savedRef = itemState.referenceNumber || '';
          var hasRef = /^FIT\d{7}$/.test(savedRef);
          if (hasRef) {
            refNumHtml = '<div class="doc-card-ref" style="margin-top:8px;">' +
              '<label style="font-size:11px;font-weight:700;color:var(--gp-muted,#64748b);display:block;margin-bottom:4px;">Fit2Work Reference Number (read from your page)</label>' +
              '<div style="display:flex;gap:6px;align-items:center;justify-content:space-between;border-radius:8px;border:1px solid #d1fae5;background:#ecfdf5;padding:8px 10px;">' +
                '<span style="font-size:14px;font-weight:800;color:#047857;letter-spacing:0.5px;">' + escapeHtml(savedRef) + '</span>' +
                '<span style="font-size:11px;color:#059669;font-weight:700;">✓ Verified</span>' +
              '</div>' +
              (itemState.fileName ? '<div style="font-size:11px;color:var(--gp-muted,#64748b);margin-top:6px;">Uploaded: ' + escapeHtml(itemState.fileName) + '</div>' : '') +
              '<label class="btn btn-soft" style="margin-top:8px;cursor:pointer;font-size:12px;display:inline-block;">Re-upload page<input type="file" data-ichc-upload="criminal_history" accept="' + AI_SCAN_ACCEPT + '" style="display:none;" /></label>' +
            '</div>';
          } else {
            refNumHtml = '<div class="doc-card-ref" style="margin-top:8px;">' +
              '<label style="font-size:11px;font-weight:700;color:var(--gp-muted,#64748b);display:block;margin-bottom:6px;">Upload your Fit2Work ICHC reference page</label>' +
              '<label class="upload-btn" style="cursor:pointer;"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>Upload page<input type="file" data-ichc-upload="criminal_history" accept="' + AI_SCAN_ACCEPT + '" /></label>' +
              '<div style="font-size:11px;color:var(--gp-muted,#64748b);margin-top:6px;">We’ll read your reference number from the page automatically.</div>' +
            '</div>';
          }
        }
```

- [ ] **Step 3: Remove the now-dead "Mark Requested requires typed ref" path.** Grep anchor: the `markBtnHtml` block `if (item.key === 'criminal_history') { markBtnHtml = ...criminalMarkBtn... disabled ...}`. For `criminal_history`, do **not** render a Mark Requested button (upload+verify drives status). Change that branch so criminal_history produces `markBtnHtml = ''`. Leave the non-criminal branch unchanged.

- [ ] **Step 4: Wire the upload handler + verification.** Grep anchor: the existing `panelsWrap.addEventListener("change", function(event) {` that handles `input[type='file'][data-prepared-doc]`. Add a sibling handler (or extend it) for `[data-ichc-upload]`. Place `runIchcVerification` near `runPreparedDocumentClassificationCheck`.

```js
      // ── Fit2Work ICHC upload + AI verify ──
      panelsWrap.addEventListener("change", function (event) {
        var input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        if (!input.matches("input[type='file'][data-ichc-upload]")) return;
        var file = input.files && input.files[0];
        if (!file) return;
        input.value = "";
        if (/^(video|audio)\//i.test(file.type) || /\.(mov|mp4|mp3|avi|wmv|mkv|flv|wav|aac|ogg|m4a|m4v|webm)$/i.test(file.name)) {
          showCertResultPopup(false, "File Not Accepted", "Video and audio files are not accepted. Please upload a PDF or image.");
          return;
        }
        if (typeof isAiScannableFile === "function" && !isAiScannableFile(file)) {
          showCertResultPopup(false, "File Not Accepted", "Please upload a PDF or image file.");
          return;
        }
        var country = getCurrentCountry();           // use the page's existing country getter
        var state = loadDocsState();                 // use the page's existing state loader
        runIchcVerification(file, state, country);
      });

      function handleIchcFailure(state, country, issuesHtml) {
        var fails = incCertFailCount('criminal_history');
        var remaining = CERT_SUPPORT_THRESHOLD - fails;
        var extra = remaining > 0
          ? '<br><span style="color:#64748b;font-size:12px;">You have ' + remaining + ' attempt' + (remaining === 1 ? '' : 's') + ' left. After that we’ll save it for our team to check by hand.</span>'
          : '';
        if (state.docs && state.docs.criminal_history) { delete state.docs.criminal_history.uploaded; }
        persistDocsState(state, true);
        renderAll(country, state);
        showCertResultPopup(false, "Couldn’t verify", issuesHtml + extra);
      }

      function runIchcVerification(file, state, country) {
        readFileAsDataUrl(file).then(function (fileDataUrl) {
          var priorFails = getCertFailCount('criminal_history');
          var isFinal = priorFails >= (CERT_SUPPORT_THRESHOLD - 1); // 3rd try → accept for manual review
          if (!state.docs) state.docs = {};
          state.docs.criminal_history = applyStoredFile({ uploaded: true, fileName: file.name, status: "scanning" }, { fileName: file.name });
          persistDocsState(state, true); renderAll(country, state);
          return fetch('/api/ai/verify-ichc', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: fileDataUrl, mimeType: file.type || 'application/pdf', fileName: file.name, country: country, finalAttempt: isFinal })
          }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (data) {
            if (data && data.isExample) {
              if (state.docs.criminal_history) delete state.docs.criminal_history.uploaded;
              persistDocsState(state, true); renderAll(country, state);
              showCertResultPopup(false, "That’s the example", data.message || "Please upload your own Fit2Work reference page, not the sample.");
              return;
            }
            if (data && data.ok && data.verified && data.referenceNumber) {
              resetCertFailCount('criminal_history');
              state.docs.criminal_history = applyStoredFile({
                uploaded: true, fileName: (data.document && data.document.fileName) || file.name,
                status: "accepted", referenceNumber: data.referenceNumber
              }, { url: (data.document && data.document.downloadUrl) || '' });
              // Keep the legacy fallback the AHPRA page also reads.
              try { var amc = JSON.parse(localStorage.getItem('gp_amc_progress') || '{}'); amc.criminalHistoryRef = data.referenceNumber; amc.updatedAt = new Date().toISOString(); localStorage.setItem('gp_amc_progress', JSON.stringify(amc)); if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push(); } catch (e) {}
              persistDocsState(state, true); renderAll(country, state);
              showCertResultPopup(true, "Verified", "Your reference page is saved and your number <strong>" + data.referenceNumber + "</strong> has been filled in for you.");
              return;
            }
            if (data && data.manualReview) {
              resetCertFailCount('criminal_history');
              state.docs.criminal_history = applyStoredFile({ uploaded: true, fileName: (data.document && data.document.fileName) || file.name, status: "under_review" }, { url: (data.document && data.document.downloadUrl) || '' });
              persistDocsState(state, true); renderAll(country, state);
              showCertResultPopup(true, "Saved for review", "We couldn’t read this automatically, so our team will check it by hand within 24 hours.");
              return;
            }
            var issues = (data && data.issues && data.issues.length) ? data.issues : [(data && data.message) || "We couldn’t verify this document."];
            handleIchcFailure(state, country, issues.map(function (s) { return getFriendlyScanMessageHtml(s, { documentTitle: 'Fit2Work ICHC reference page', mode: 'classification' }); }).join('<br>'));
          }).catch(function () {
            handleIchcFailure(state, country, "Could not connect to the verification service. Please try again.");
          });
        }).catch(function () {
          showCertResultPopup(false, "Upload Failed", "We could not read that file. Please try again.");
        });
      }
```

  Note: `getCurrentCountry()` / `loadDocsState()` are placeholders for the page's actual helpers — grep the existing `data-prepared-doc` change handler to see exactly how it obtains `country` and `state`, and reuse those identical calls. `CERT_SUPPORT_THRESHOLD` already exists (value 3 — confirm).

- [ ] **Step 5: Remove dead handlers.** Grep anchors: the click handler branch `var refSaveBtn = target.closest(".criminal-ref-save");` and the `input` listener that watches `.criminal-ref-input` / `criminalMarkBtn`, and the `if (key === 'criminal_history') { ... crimRefInput ... }` guard inside the Mark-Requested click handler. These reference the removed text input; delete them (or no-op the criminal_history guard) so no dead listeners remain. Verify nothing else references `criminal-ref-input`/`criminalMarkBtn` after removal (grep returns nothing).

- [ ] **Step 6: Manual smoke + commit.** Open the page logic mentally: card renders Upload when no ref; after a verified response it shows the green number + Re-upload. Then:

```bash
git add pages/my-documents.html
git commit -m "My Documents: upload+verify Fit2Work ICHC page (replaces typed ref box) + sample in Show me how"
```

---

### Task 4: AHPRA gateway surfacing (`pages/ahpra.html`)

**Files:**
- Modify: `pages/ahpra.html`

**Interfaces:**
- Consumes: the saved `criminal_history` doc state in `localStorage` `gp_documents_prep` (`.docs.criminal_history.{referenceNumber,url,status}`) written by Task 3, and the AHPRA Row-2 reference display already reads `criminalHistoryRef`.

- [ ] **Step 1: Route `criminal_history` to the ICHC box.** Grep anchor: `function ahpraDocCategory(key) {`. Add as the first check:

```js
      if (key === "criminal_history") return "ichc";
```

- [ ] **Step 2: Add a `criminal_history` row to the download snapshot.** Grep anchor: in `getDocSnapshot()`, after `const rowsGp = GP_REQUIRED_DOCS.map(...)`. Build an institution row from `docState`:

```js
      const crim = (docState.docs && docState.docs.criminal_history) || {};
      const crimReady = crim.status === "accepted" || crim.status === "approved" || !!crim.url;
      const crimUnderReview = crim.status === "under_review";
      const rowsInstitution = [{
        group: "gp",
        key: "criminal_history",
        name: "Fit2Work ICHC Reference Page" + (crim.referenceNumber ? " (" + crim.referenceNumber + ")" : ""),
        uploaded: crim.uploaded === true,
        ready: crimReady,
        rejected: crim.status === "rejected",
        status: crim.status === "rejected" ? "Rejected" : crimReady ? "Ready" : crimUnderReview ? "Pending" : crim.uploaded ? "Pending" : "Not ready",
        reason: crimReady ? "Saved on the Documents page." : crimUnderReview ? "Under review by GP Link (up to 24 hours)." : "Upload your Fit2Work reference page on the Documents page.",
        downloadUrl: typeof crim.url === "string" ? crim.url : "",
        category: "ichc"
      }];
```

  Then include it in the combined arrays. Grep anchor: `const all = [...rowsGp, ...rowsGpLinkAll];` → change to:

```js
      const all = [...rowsInstitution, ...rowsGp, ...rowsGpLinkAll];
```

- [ ] **Step 3: Update the ICHC section's empty copy.** Grep anchor: the `AHPRA_DOWNLOAD_SECTIONS` entry `key: "ichc"` with `empty: "We'll guide you through this step separately — coming soon. There's nothing to download here yet."`. Since the section now always has a row, the `empty` string is effectively unused, but update it for safety:

```js
        empty: "Upload your Fit2Work reference page on the Documents page to add it here.",
```

- [ ] **Step 4: Add the sample to the "Send directly to AHPRA" help.** Grep anchor: the config feeding `renderAdditionalDocsModal` — `const ADDITIONAL_DOCS = {` — and also `INTRO_COUNTRY_DOCS`. After each is defined, append the sample step to every `criminal_history` help, mirroring Task 3 Step 1 (DRY loop). Define `ICHC_EXAMPLE_STEP_HTML` once in this page's scope and run the same `Object.keys(...).forEach` over both `ADDITIONAL_DOCS` and `INTRO_COUNTRY_DOCS` (both keyed by country with `.institution` arrays):

```js
    var ICHC_EXAMPLE_STEP_HTML = 'See what the page looks like: <a href="/documents/fit2work-ichc-example.pdf" target="_blank" rel="noopener noreferrer">view a sample Fit2Work ICHC reference page</a>. This is only an example — upload your own page, not this sample.';
    [INTRO_COUNTRY_DOCS, ADDITIONAL_DOCS].forEach(function (cfgMap) {
      Object.keys(cfgMap).forEach(function (c) {
        (cfgMap[c].institution || []).forEach(function (d) {
          if (d.key === 'criminal_history' && d.help && Array.isArray(d.help.steps)
              && d.help.steps.indexOf(ICHC_EXAMPLE_STEP_HTML) === -1) {
            d.help.steps = d.help.steps.concat([ICHC_EXAMPLE_STEP_HTML]);
          }
        });
      });
    });
```

  (Place this after BOTH configs are declared. If they are declared far apart, run two separate loops at the point each is in scope.)

- [ ] **Step 5: Syntax-sanity + commit.** There is no node check for HTML; instead confirm balanced braces by loading the file mentally / search for the new identifiers. Then:

```bash
git add pages/ahpra.html
git commit -m "AHPRA gateway: surface ICHC page in download pack (ICHC box) + sample in Show me how"
```

---

### Task 5: Full verification + asset commit

**Files:** none new (verification only).

- [ ] **Step 1: Commit the example asset** (if not already committed):

```bash
git add documents/fit2work-ichc-example.pdf
git commit -m "Add redacted Fit2Work ICHC sample page for Show me how"
```

- [ ] **Step 2: Server syntax**

Run: `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH" && node --check server.js`
Expected: exit 0, no output.

- [ ] **Step 3: Full test suite**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: all green — 596 prior tests + the new `tests/ichc-verify.test.js`, 0 failures.

- [ ] **Step 4: Grep for leftovers** — confirm the removed identifiers are gone and the new wiring is present:

Run: `grep -nE "criminal-ref-input|criminal-ref-save|criminalMarkBtn" pages/my-documents.html` → expect **no matches**.
Run: `grep -nE "data-ichc-upload|verify-ichc|fit2work-ichc-example" pages/my-documents.html pages/ahpra.html server.js` → expect matches in each.

- [ ] **Step 5: Manual review checklist** (record findings, do not fake):
  - My Documents UK/IE/NZ: criminal-history card shows Upload (no typed box); "Show me how" links the sample PDF.
  - The sample PDF opens at `/documents/fit2work-ichc-example.pdf`.
  - AHPRA download pack shows "International Criminal History" with the criminal_history row (Awaiting upload → Ready once saved).
  - AHPRA Row 2 still shows the reference number once verified (reads `gp_amc_progress.criminalHistoryRef`).

- [ ] **Step 6: Final commit if any fixups**, then stop for human review before any production push.

## Self-Review notes (author)

- **Spec coverage:** verify (Task 2 AI), extract+prefill (Task 2 returns ref → Task 3 stores to both localStorage keys → AHPRA reads), save (Task 2 `savePreparedDocumentForUser`), example in Show me how (Task 3/4), block example (Task 1 refs+hash, enforced Task 2 on every path), 3-fail→manual review (Task 2 `finalAttempt` + `ensureDocReviewOnUpload`; Task 3 counts attempts), AHPRA extrapolation (Task 4). All covered.
- **Type consistency:** client reads `data.referenceNumber`, `data.verified`, `data.isExample`, `data.manualReview`, `data.document.{downloadUrl,fileName}` — matches Task 2 responses. Status strings `accepted`/`under_review`/`rejected` consistent across save (Task 2) and snapshot (Task 4).
- **Known follow-up for implementer:** confirm `ensureDocReviewOnUpload` reviewStage arg, `CERT_SUPPORT_THRESHOLD` value (3), and the exact `country`/`state` accessors in the My Documents change handler — all flagged inline.
