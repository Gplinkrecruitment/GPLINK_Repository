# Guided "Scan a Document" — Prepare Early, Know What to Scan

**Date:** 2026-06-14
**Status:** Design — awaiting review
**Branch:** `worktree-scan-guided-prepare`

## Problem

The glowing **Scan** button in the bottom nav is visible from every page, but tapping it
opens a generic, document-blind modal: "Use Camera / Upload File." A GP staring at it has
no idea **what** to scan, **which** of their documents it's for, or **what makes a good
scan**. The camera view shows one fixed hint for everything — *"AI recommendation: Bring
Closer, ensure clear"* — and the actual document requirements (certified copy, certifier's
signature/stamp) live on a different page (AHPRA help), never in the scan flow.

The machinery behind the button is good — Claude verifies document type, matches the name,
checks certification markings, and humanizes errors. The gap is purely **guidance before
the scan**: the GP is never told what to point the camera at.

Secondary, equally important constraint (from the product owner): **these documents can and
should be prepared and scanned early — well before the GP reaches the AHPRA step.** Nothing
about scanning should be gated on registration progress. Certified copies in particular need
a solicitor/notary visit and have real-world lead time, so starting early matters.

## Goals

1. When a GP taps **Scan**, immediately show **which document to scan next**, drawn from
   their own outstanding checklist — not a blank camera.
2. Make the flow work **from day one**, independent of registration step. Scans persist and
   are already attached when the GP later reaches AHPRA.
3. In the camera, replace the single generic hint with **guidance tailored to the specific
   document** — what must be in frame, and (for certified copies) that the certifier's
   stamp/signature/"true copy" line must be visible.
4. Never dead-end: an "all caught up" state and a graceful fallback when the GP's training
   country isn't known yet.
5. **End-to-end correctness:** a scan started from the global nav button must verify, save,
   and read back exactly as one started from My Documents — same store, same server, same
   re-scan/fail handling.

## Non-Goals

- No change to the AI verification endpoints (`/api/ai/verify-qualification`,
  `/api/ai/verify-certification`, `/api/ai/classify-document`) or their prompts.
- No change to the registration flow, step ordering, or which documents are required.
- No redesign of the My Documents page layout itself (only its scan/save logic is shared out).
- No new "general identify-anything" scanning. Every scan in the new flow is tied to a
  known target document. (The legacy generic mode may remain as a hidden fallback but is
  not surfaced.)

## Chosen Approach — Option B: Smart, document-driven router

Tapping **Scan** opens a router sheet that:

1. Resolves the GP's training country (`getSelectedCountryCode()` → `GB`/`IE`/`NZ`).
2. Builds their required "you provide" document checklist from the shared config.
3. Reads persisted prepared-docs state to find which are still **outstanding**.
4. Orders the outstanding list **certified-copies-first** (longest real-world lead time),
   then remaining documents in checklist order.
5. Renders **Suggested next** (the first outstanding doc) front and centre with a single
   **Scan this now** button, plus a **collapsed "Pick another document" dropdown** (closed
   by default, badge shows count remaining) that expands to the rest.
6. Tapping any document opens the camera **pre-set for that document**, with a per-document
   tip checklist, and runs the correct verification + save path.

This was chosen over (A) a flat picker and (C) an intro-then-picker because it leads with a
single clear next action while keeping the full list one tap away, and because "suggested
next + progress" naturally communicates the get-ahead-early message.

### Visual reference

Approved mockups (in `$CLAUDE_JOB_DIR/tmp`, not committed):
`scan-option-b-revised.html` (main + all-caught-up states),
`scan-option-b-dropdown.html` (collapsed vs expanded "Pick another"),
`scan-camera-tips.html` (camera before/after).

## Architecture

The core change is **extracting the document-prep brain out of `my-documents.html` into a
shared module** so both My Documents and the global Scan flow use one source of truth.

### Component 1 — `js/document-prep.js` (new shared module)

Extracted from the logic currently inline in `pages/my-documents.html`. Exposes a small
window-scoped API (matching the existing global-function convention, e.g. `window.gpDocPrep`):

- `getCountryDocs(country)` — the `prepared[]` list for a country (key, title, `help.certNote`).
  Sourced from the existing `COUNTRY_DOCS` config, moved here.
- `loadDocsState(country)` / `persistDocsState(state, sync)` — localStorage + Supabase state
  (unchanged behaviour, just relocated).
- `savePreparedDocumentFile(country, key, storedFile)` — server persist via
  `/api/prepared-documents` (unchanged).
- `getOutstandingDocs(country)` — returns ordered outstanding documents (see Selection logic).
- `getPrepProgress(country)` — `{ prepared, total }` for the progress bar.

`my-documents.html` is refactored to consume this module instead of its own copies, so there
is exactly one implementation. No behavioural change to My Documents is intended; this is a
pure extraction validated by its existing flows still working.

### Component 2 — Scan router sheet (in `js/qualification-scan.js`)

A new entry `window.gpOpenScanRouter()` replaces what the nav button calls today
(`gpOpenScanModal()`). It renders the router sheet described above using `gpDocPrep`, then
delegates each document to the existing per-document scan entry:

- `data-qual-scan-trigger` (the bottom-nav button, `pages/app-shell.html`) now invokes
  `gpOpenScanRouter()` instead of `gpOpenScanModal()`.
- Selecting a document calls a unified `gpOpenDocScan(docKey, title, { requireCert, onComplete })`:
  - `requireCert = doc.help.certNote` → runs the certification flow (`verify-certification`
    + classification), exactly as My Documents does today via `gpOpenCertScan`.
  - `requireCert = false` → runs qualification/classification only (type + name), skipping
    the certification check.
  - `onComplete` saves through `gpDocPrep.savePreparedDocumentFile` + `persistDocsState`,
    so the result lands in the same store regardless of where the scan started.

`gpOpenCertScan` (used by My Documents) is preserved as a thin wrapper over `gpOpenDocScan`
with `requireCert: true`, so existing call sites keep working.

### Component 3 — Camera guidance layer (in `js/qualification-camera.js`)

The camera overlay gains:

- A **top pill** showing the target document name + a "CERTIFIED COPY" badge when
  `requireCert`.
- A **tip checklist card** above the shutter, populated from a per-document tip map keyed by
  document key, falling back to a sensible default. Replaces the single static
  `"AI recommendation: Bring Closer, ensure clear"` line.
- A **rule-based live hint chip** ("Lighting good · hold steady" / "Move closer") derived
  from cheap client-side signals (frame brightness/size heuristics already available in the
  capture path). **No AI calls** — this is purely local.

### Per-document tip map

A plain, editable object (in `js/qualification-camera.js` or alongside the doc config) so
wording can be tuned without touching logic:

```js
const SCAN_TIPS = {
  _certifiedDefault: [
    "All four corners of the page in frame",
    "The certifier's stamp & signature are sharp",
    "The 'I certify this a true copy' line is readable"
  ],
  _plainDefault: [
    "Show your full name and the document date",
    "Whole page in frame, no fingers over text",
    "Even lighting, no glare"
  ],
  primary_medical_degree: [ /* certified-specific overrides, else _certifiedDefault */ ],
  criminal_history: [ /* plain-specific overrides, else _plainDefault */ ],
  // ...
};
```

Resolution: explicit per-key tips if present, else `_certifiedDefault` when `requireCert`,
else `_plainDefault`.

## "Suggested next" selection logic

`getOutstandingDocs(country)`:

1. Start from `getCountryDocs(country).prepared` (checklist order).
2. Drop any document already in a satisfied state (`uploaded && aiVerified`, or
   `status: "under_review"` after passing checks) per `loadDocsState`.
3. **Stable sort: `certNote === true` first, then the rest** — preserving checklist order
   within each group.
4. `Suggested next` = first element. The remainder populate the collapsed dropdown.

Edge: all satisfied → empty list → router shows the **all-caught-up** state (confirmation +
"Re-scan a document" / "Scan something else").

## Country-unknown fallback

`gp_selected_country` is set during onboarding (`js/onboarding.js`) and at sign-in, so it is
essentially always present once a GP is in the app. If it is genuinely missing,
`getSelectedCountryCode()` already defaults to `GB`. The router additionally shows a one-tap
**"Where did you train?"** chooser (GB / IE / NZ) when no country is stored, writes
`gp_selected_country`, then proceeds. No dead-end, no silent wrong guess.

## End-to-end data flow

```
Nav "Scan"  →  gpOpenScanRouter()
                 → gpDocPrep.getOutstandingDocs(country)        [read state]
                 → render Suggested next + dropdown + progress
   tap doc   →  gpOpenDocScan(key, title, {requireCert, onComplete})
                 → camera (per-doc tips)  →  capture/upload
                 → /api/ai/classify-document (+ verify-certification if requireCert)
   success   →  onComplete:
                 → gpDocPrep.savePreparedDocumentFile(country, key, storedFile)  [POST /api/prepared-documents]
                 → gpDocPrep.persistDocsState(state, true)        [localStorage + Supabase via state-sync]
   read-back →  My Documents (any later visit) loads the same state → shows the doc as done
```

Because persistence goes through the server (`/api/prepared-documents`) and the shared state
store (synced by `js/state-sync.js`), a scan started from the global nav button on **any**
page — including while another page is shown in the app-shell iframe — is visible to My
Documents on its next load. The router and My Documents read identical state.

## States & error handling

- **Main:** Suggested next + progress + collapsed dropdown.
- **All caught up:** confirmation, re-scan / scan-something-else.
- **Country unknown:** inline GB/IE/NZ chooser, then main.
- **In-progress / scanning:** unchanged spinner step from `qualification-scan.js`.
- **Failure:** existing humanized errors (`gpFriendlyScanIssues`) shown in-flow; the target
  document is preserved so "Try again" re-opens the same camera.
- **Repeated failures:** the existing failure-count behaviour
  (`handlePreparedDocClassificationFailure`, `CERT_SUPPORT_THRESHOLD = 3`) moves into the
  shared module and continues to apply — after repeated fails the GP is guided to support /
  manual review, identically from either entry point.
- **Name mismatch / date rules / rate limits / budget queue:** unchanged server behaviour;
  surfaced via the same humanized messages.

## Testing

- **Unit (vitest):** `getOutstandingDocs` ordering (certified-first, stable within group),
  progress counts, all-caught-up empties, country normalization + fallback, tip resolution
  (explicit key → certified default → plain default).
- **Extraction safety:** existing My Documents flows (upload, cert scan, fail counting,
  re-render) behave identically after consuming `gpDocPrep` — covered by existing tests plus
  a focused test that My Documents and the router compute the same outstanding list from the
  same state.
- **End-to-end (manual, documented honestly):** scan a certified doc from the **nav** button
  on a non-Documents page → confirm it persists server-side and shows as done in My
  Documents. Per CLAUDE.md, any manual trigger is reported as manual, never presented as
  automatic.

## Out of scope / future

- Real-time AI framing feedback (we use cheap local heuristics only).
- Reworking the AI prompts or adding new document types.
- Desktop scan affordance (this flow targets the mobile nav button; desktop upload unchanged).

## Resolved decisions

- Entry flow: **Option B** (smart document-driven router). ✔ approved
- Ordering: **certified-copies-first**, then checklist order. ✔ approved
- "Pick another": **collapsed dropdown, closed by default**. ✔ approved
- Country-unknown: inline GB/IE/NZ chooser fallback. ✔ (owner deferred to recommendation)
- Tip wording: editable per-document map. ✔ (owner deferred to recommendation)
