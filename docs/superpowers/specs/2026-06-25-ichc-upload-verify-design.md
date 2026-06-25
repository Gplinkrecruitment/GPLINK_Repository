# Fit2Work ICHC Reference Page — Upload & AI Verify

**Date:** 2026-06-25
**Branch:** `worktree-ichc-upload-verify`
**Status:** Approved design

## Problem

In the Direct-to-AHPRA flow, the GP completes an international criminal-history check
through **Fit2Work** and receives an **ICHC Reference Page** (PDF) containing a reference
number in the form `FIT` + 7 digits (e.g. `FIT7623801`).

Today, in **My Documents → "Direct to AHPRA"**, the `criminal_history` card shows a text
box (`FIT▢▢▢▢▢▢▢`) where the GP **types** the number. The typed number is stored in
`localStorage` (`gp_documents_prep.docs.criminal_history.referenceNumber` and
`gp_amc_progress.criminalHistoryRef`) and displayed on the AHPRA page for copying into the
AHPRA application. The actual reference page is never uploaded or verified — the GP could
type any number, and nothing is saved.

## Goal

Replace the typed-number box with an **upload** control. When the GP uploads their Fit2Work
ICHC reference page, the platform's AI:

1. Verifies it is a genuine Fit2Work ICHC reference page.
2. Extracts the `FIT` reference number and pre-fills/saves it (so the existing AHPRA display
   keeps working with zero downstream changes).
3. Saves the uploaded document to the GP's document store (`user_documents`).
4. Shows a **redacted example** of the page in "Show me how".
5. Blocks the GP from uploading the example and passing it off as their own.

The uploaded page and its reference number must surface consistently wherever other
My Documents are shown — including the **AHPRA gateway** (the "Send directly to AHPRA"
helper, the reference-number guidance row, and the AHPRA download pack's
"International Criminal History" section).

## Decisions (confirmed with owner)

- **Example doc:** Use the redacted PDF (placeholder ref `FIT1234567`, all personal values
  blank). Host it in-app; never publish the original (which contains a real person's PII).
- **If AI cannot verify:** GP gets up to **3 attempts**. On the 3rd failed scan, the page is
  **accepted, saved, and an admin review task is created** (mirrors the existing
  certification 3-fail → manual-review rule). The example block still applies on every path.
- **Anti-cheat scope:** Block the **example itself** only — by its reference numbers
  (`FIT1234567`, `FIT7623801`) and by exact file fingerprint (SHA-256) of both example files.
  No account-name matching required.

## Architecture

### New server endpoint: `POST /api/ai/verify-ichc`

Mirrors `POST /api/ai/verify-certification` (server.js ~25922) for auth, budget, daily
per-user AI limit, image-normalisation, and PDF/image content-block handling.

Request body: `{ imageBase64, mimeType, fileName, country, finalAttempt? }`

Flow:
1. `requireSession`; if no `ANTHROPIC_API_KEY` → 503; budget/limit checks as cert endpoint.
2. `validateFileUpload(buffer, mimeType, fileName)` (reuse existing validator).
3. **Example fingerprint block (always, before AI):** compute SHA-256 of the file buffer; if
   it matches a known example hash → return `{ ok:true, verified:false, isExample:true }` and
   **do not save**.
4. Call Anthropic vision with an ICHC-specific system prompt. Return strict JSON:
   `{ isIchcReferencePage:bool, referenceNumber:"FIT#######"|null, applicantName:string|null, issues:[...] }`.
5. **Example reference block:** if `referenceNumber` is `FIT1234567` or `FIT7623801` →
   `{ ok:true, verified:false, isExample:true }`, **do not save**.
6. **Verified path:** if `isIchcReferencePage` && `referenceNumber` matches `/^FIT\d{7}$/`:
   - Save the file to `user_documents` (key `criminal_history`, status `accepted`).
   - Return `{ ok:true, verified:true, referenceNumber, applicantName, document }`.
7. **Unverified path:**
   - If `finalAttempt === true`: save the file (status `under_review`) **and create an admin
     review task** ("Manually review Fit2Work ICHC page — AI could not verify after 3
     attempts"); return `{ ok:true, verified:false, manualReview:true, document }`.
     (Re-check example fingerprint/ref here too — the example can never be saved.)
   - Else: return `{ ok:true, verified:false, issues }` and do **not** save (client manages
     the attempt counter).

**Reference-number storage:** the canonical store for *display* stays the client
`localStorage` keys (`gp_documents_prep.docs.criminal_history.referenceNumber` and
`gp_amc_progress.criminalHistoryRef`) — unchanged, so the AHPRA page and admin profile keep
working with no migration. Server-side, the extracted number is returned to the client and
written into the saved `user_documents` row's existing free-text field (e.g. appended to/stored
alongside `file_name`, or a `metadata`/`notes` column **iff one already exists** — confirm the
`user_documents` schema during implementation; do **not** add a migration just for this).

**Single-call attempt handling (no double upload):** the client knows the current fail count
*before* it calls. When the prior fail count is already 2 (i.e. this upload is the GP's 3rd
try), the client sends `finalAttempt:true` on that same call. So each attempt is exactly one
request: attempts 1–2 either verify or return `verified:false` (nothing saved); the 3rd call
either verifies or is saved as `under_review` + admin task. No re-POST.

Notes:
- The server treats `finalAttempt` as advisory; even if a client always sends it, the worst
  case is a human reviews the doc — no security risk, and the example stays hard-blocked.
- Persistence reuses `savePreparedDocumentForUser` (the same helper behind
  `PUT /api/prepared-documents`) so the file lands in `user_documents` with storage upload.

### Client: My Documents (`pages/my-documents.html`)

In the `institution` group render (criminal_history card, ~line 2038):
- Replace the `FIT____` text input + Save button with an **Upload** control
  (`<input type="file" accept="image/*,.pdf">`), styled like the existing prepared-doc
  upload, plus mobile "Scan Document" parity if `gpOpenCertScan` is available.
- On change → `runIchcVerification(file, state, country)`:
  - Block video/audio (reuse existing guard); read file → base64 data URL.
  - POST `/api/ai/verify-ichc`.
  - `verified:true`: reset fail count; store `referenceNumber` into
    `state.docs.criminal_history.referenceNumber` **and** `gp_amc_progress.criminalHistoryRef`
    (keep existing keys so AHPRA display is unchanged); set status `accepted`, `uploaded:true`,
    `fileName`, `downloadUrl`; success popup showing the saved `FIT…` number.
  - `isExample:true`: hard-reject popup ("That's the example document — upload your own");
    do **not** count toward the 3 attempts.
  - `verified:false` (not example): `handleIchcFailure(...)` → increment a per-key fail count
    (reuse the existing `certFailCounts` mechanism). `<3`: "couldn't verify, try again
    (attempt X of 3)". `>=3`: re-POST with `finalAttempt:true`; on success show "We'll review
    this by hand" and set status `under_review`.
- After verification, the card shows the verified `FIT…` number (read-only, copyable) and the
  uploaded file name with a "Re-upload" option. The "Mark Requested" button is removed (upload
  + verify replaces it).
- Update the `criminal_history` `help` object (~line 1305) so "Show me how" links to the
  example: `/documents/fit2work-ichc-example.pdf` with an "Example only — upload your own" note.

### Client: AHPRA page (`pages/ahpra.html`) — extrapolation

- **Reference-number guidance row** (`buildQualGuidanceHtml`, Row 2, ~line 3867): already
  reads `criminalHistoryRef` from `localStorage`; auto-fills from the verified number. No
  logic change; verify wording still accurate.
- **"Send directly to AHPRA" helper** (`renderAdditionalDocsModal`, ~line 3729): the
  `criminal_history` row's "Show me how" gains the example link; status reflects
  Verified/Uploaded once the page is saved.
- **AHPRA download pack — "International Criminal History" section** (currently an empty
  placeholder; see memory `ahpra-download-pack-4-sections`): surface the uploaded ICHC page
  here as a downloadable document, consistent with how other `user_documents` appear in that
  pack.

### Asset

- Add the redacted example PDF to `documents/fit2work-ichc-example.pdf` (served statically,
  same as `/documents/section_g.pdf`).

## Data flow (end-to-end)

UI upload → `/api/ai/verify-ichc` (verify + extract + example-block) → save to
`user_documents` + store ref → client writes ref to `gp_documents_prep` +
`gp_amc_progress` → AHPRA Row 2 / "Send directly" helper / download pack all read the saved
ref + document. On 3 failures → saved as `under_review` + admin review task.

## Error handling

- AI service down / 502 / budget reached → counts as an unverified attempt (3-attempt rule
  applies; manual review on the 3rd).
- Oversized image (`>15MB` base64) → 413 with a clear message (as cert endpoint).
- File validation failure → 400 with the validator's message.
- Example detected → never saved, on any path.

## Testing

- Unit tests for the ICHC reference-number / example-detection logic (regex, example refs,
  hash block) — pure helpers extracted so they are testable without the network.
- `node --check server.js` before any push.
- Full `vitest run` suite must stay green (existing gate).

## Out of scope

- Account-name matching anti-cheat (owner chose "block the example only").
- Re-working the broader AHPRA download-pack architecture beyond surfacing this one doc.
