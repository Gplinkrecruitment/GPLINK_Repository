# Onboarding identity-document storage → Google Drive + CEO profile

**Date:** 2026-07-24
**Status:** Approved (design) — pending spec review
**Owner ask:** "On onboarding when the user uploads identity document make sure to save this on their Google Drive file and on their GP profile on the CEO dashboard." Retention wording + a silent 6-month-post-placement purge added during brainstorming.

## Goal

Persist the identity document a GP uploads during onboarding, mirror it to their
Google Drive folder, and make it viewable on their profile in the CEO dashboard —
governed by a truthful retention/deletion policy.

## Background — what happens today (the two privacy decisions we're changing)

1. **The onboarding identity step is verify-only and stores nothing.** Step 4
   ("Confirm your identity", `pages/onboarding.html:1441+`) base64-POSTs the photo
   to `POST /api/ai/verify-identity` (`server.js:47394`). The handler asks Anthropic
   to read the name, cross-checks it, returns `{ ok, verification }` (`server.js:47577`),
   and **discards the image** — no `user_documents` insert, no storage, no Drive.
   The screen explicitly promises: *"Your document is deleted immediately after
   verification. We only check the name — nothing is stored."* (`pages/onboarding.html:1466-1467`).
2. **The CEO documents panel deliberately hides the ID.** `GET /api/admin/gp-documents`
   (`server.js:51848`) builds cards from an allow-list (`GP_DOCUMENT_META` `server.js:6532`,
   `GP_LINK_DOCUMENT_META`) — neither contains an identity entry — and its catch-all
   `otherFiles` explicitly filters the ID out (`server.js:52100-52104`, comment: *"The
   sensitive ID document is never surfaced here."*). The ATS candidate file
   (`js/ceo-ats-candidates.js:1417-1443`) shows only an "Identity document —
   Uploaded / Not uploaded" pill (never a viewable link), keyed off the legacy
   profile column `user_profiles.id_copy_data_url` via `atsGetDocFlagsProd`
   (`server.js:32557-32570`).

This feature reverses both, so the user-facing wording MUST change to stay truthful
(CLAUDE.md rule #1).

## Requirements

R1. On onboarding identity upload, **persist the file** (our storage) so it can be
    viewed later, rather than discarding it.
R2. **Mirror the file to the GP's Google Drive folder**, in their existing "ID"
    subfolder.
R3. The GP's **CEO-dashboard profile shows a viewable "Identity document" card** (CEO
    can open/download the image).
R4. **Replace the onboarding wording** so the user is told the ID is stored (not
    deleted) and why, plus the disclosed deletion conditions.
R5. **Retention / deletion** — one shared purge routine, three triggers:
    - **On request** — a delete button on the CEO/ATS profile (CEO/ATS only, per R6).
    - **6 months after placement** — automatic, **silent (never disclosed to the GP)**.
    - **12 months of app inactivity** — automatic, disclosed.
R6. **Visibility** — the viewable ID is restricted to the **CEO and future ATS
    users ONLY**. It is **NOT** visible to RSOs (assigned GP Link officers), practices,
    or other GPs. This is stricter than the audience for the GP's other documents (which
    RSOs can see), so the identity card must be role-gated separately.

## Non-goals (YAGNI)

- Practices viewing the passport image (they don't; the ID only underwrites GP Link's
  "this is a real doctor" assurance).
- Self-serve GP deletion button (deletion-on-request is staff-handled for now).
- Reworking the AI name-check logic itself (unchanged).

## Design

### Component A — Persist the uploaded ID (R1)

Store using the same proven path the qualification onboarding docs use
(`saveAccountCareerDocumentForUser` template, `server.js:7269-7303`): a Supabase
storage object **plus** a `user_documents` row.

- `document_key = 'identity'` (already recognised by the Drive layer —
  `lib/drive-doc-folders.js:42` maps it to the "ID" subfolder).
- `country_code` = the onboarding country **lowercased** (`uk`/`ie`/`nz`/…) so it
  matches the CEO panel's country filter (`server.js:51880`; casing gotcha per
  `user-documents-country-code-casing`).
- `status` = a neutral value (e.g. `uploaded`) that does **not** enrol the ID into the
  qualification/AHPRA document-review pipeline. The ID must never generate a doc-review
  task.
- Approach: extend `POST /api/ai/verify-identity` so that, after the image is read,
  it also persists it (Supabase storage + `user_documents` upsert), then returns the
  verification result as before. Persist regardless of name-match outcome (mismatch is
  a name-change signal, not a rejection — see `namechange-scan-flow`), but only when a
  readable image was received. This keeps identity handling self-contained in one
  endpoint and avoids routing the ID through `saveOnboardingDocumentForUser`'s
  qualification keys.

### Component B — Mirror to Google Drive (R2)

Reuse the existing Drive helpers: `ensureGPDriveFolder(caseId, first, last)`
(`server.js:820`) → `ensureDocTypeSubfolder(folderId, 'ID', …)` (`server.js:941`,
name from `lib/drive-doc-folders.js` `ID_FOLDER`) → upload.

- Upload **privately** (`uploadPrivateToGoogleDrive`, mode `id_private` /
  hello@-only, `server.js:807`). The CEO views the ID through our app (signed Supabase
  URL), so the Drive copy is archival and does not need broad sharing.
- Filename keeps the load-bearing `'ID — …'` prefix (matched in
  `reconcileGpDrive`/CEO panel).
- Wire it **synchronously inside the verify-identity handler** after the Supabase
  save (mirrors the approval-time `uploadDocumentToDrive` pattern), with
  `reconcileGpDrive` (`server.js:840`, already run on every CEO documents view) as a
  backstop. Extend `reconcileGpDrive`'s ID-mirror branch (`server.js:909-923`) to also
  source from the new `user_documents` `identity` row, not only the legacy
  `id_copy_data_url`.
- No Google creds locally ⇒ `isGoogleDriveConfigured()` false ⇒ every Drive helper is a
  silent no-op (`server.js:631`); the Supabase copy and CEO card still work.

### Component C — CEO-dashboard viewable card, role-gated (R3, R6)

- Add an **`identity` entry to the CEO documents allow-list** so `GET
  /api/admin/gp-documents` emits a card for the `identity` `user_documents` row
  (matched the same way qualification cards are, `server.js:51976-52001`), with a
  view/download link resolving the Supabase storage object (signed URL) like other
  document cards.
- **Role-gate the identity card (R6): emit it ONLY when the requester is a CEO /
  super-admin (or a future ATS-user role); OMIT it entirely for RSO requests.** The
  gp-documents endpoint is reached by RSOs too (scoped to their assigned GPs), so the
  gate is a server-side role check on the requester — not just a UI hide. The plan must
  locate the CEO-vs-RSO/super-admin distinction used elsewhere (`rso-assigned-gp-lockdown`
  already separates CEO from RSO) and add a single `canViewIdentity(requester)` predicate
  that today = CEO/super-admin and is trivially extensible to an ATS role. When false, the
  identity card (and its signed URL) is never included in the response — RSOs receive no
  identity data at all.
- **Lift the ID exclusion for this card only**: the `otherFiles` filter at
  `server.js:52100-52104` stays (raw Drive "ID — " files still shouldn't leak into the
  generic bucket); the ID appears solely as the dedicated, role-gated allow-listed card.
- Update the **ATS candidate file** (`js/ceo-ats-candidates.js`): `atsGetDocFlagsProd.idDoc`
  (`server.js:32570`) also true when the `identity` `user_documents` row exists, and the
  "Identity document" line becomes a viewable link — **also gated by `canViewIdentity`**
  (CEO/ATS only). The onboarding "Identity verified" pill (`server.js:32811`) is unchanged
  and may remain visible to RSOs (it is a yes/no flag, not the file).
- **Deletion control (R5 on-request)** is likewise CEO/ATS-only, consistent with viewing.

### Component D — Onboarding wording (R4)

Replace `pages/onboarding.html:1466-1467` with (final copy):

> *"We store your ID securely so GP Link can confirm you're a real doctor and vouch
> for you to practices. We'll delete it whenever you ask, or after 12 months of
> inactivity."*

- Discloses two of the three deletion triggers; the 6-month-post-placement purge is
  intentionally **not** mentioned (owner instruction). This is truthful: we never
  retain the ID *longer* than the copy promises — the undisclosed trigger only deletes
  *sooner*.
- Bump the `js/onboarding.js?v=` cache-buster wherever it's included (JS is cached ~1h;
  `js-cache-buster-really-matters`). `onboarding.html` is served no-cache, so its inline
  copy change ships immediately.

### Component E — Deletion / retention (R5)

- **`purgeStoredIdentityDocument(userId)`** — one shared helper that removes every copy:
  the Supabase storage object, the `user_documents` `identity` row, the Drive "ID — …"
  file (by stored Drive id / prefix), and clears any legacy `id_copy_data_url` /
  `id_copy_name`. Idempotent.
- **On request (CEO/ATS only):** `POST /api/admin/gp-identity-delete`, guarded by the
  same `canViewIdentity` predicate (CEO/super-admin/future-ATS — **RSOs rejected**) →
  calls the helper. A "Delete ID" control on the ID card, rendered only for CEO/ATS.
- **Automatic sweep (cron):** a periodic job purges IDs where **`placed_at + 6 months <
  now`** OR **`last_active + 12 months < now`**. Prefer extending the existing
  account-purge cron (see `account-deletion-feature`) over a new schedule.
  - Requires a reliable **placement timestamp** and a **last-activity timestamp**. The
    plan must locate existing fields (secured-placement / `placement_payload` date;
    session/`updated_at` activity) and, only if absent, stamp `placed_at` at placement
    finalisation (`finalizeInAppPlacement`).

## Data flow

Upload (onboarding step 4) → `POST /api/ai/verify-identity`
  → AI name read (unchanged) → **Supabase storage put** + **`user_documents{identity}`
    upsert** → **Drive "ID" subfolder mirror** → return `{ ok, verification }`.
CEO opens GP profile → `GET /api/admin/gp-documents` → identity card (signed-URL view).
Deletion → staff button **or** cron sweep → `purgeStoredIdentityDocument(userId)`
  → storage + row + Drive + legacy fields all removed.

## Testing

- Persistence: `verify-identity` creates a `user_documents` row `document_key='identity'`,
  `country_code` lowercased, with a storage path; does **not** create a doc-review task.
- CEO panel: `GET /api/admin/gp-documents` returns a viewable identity card when the row
  exists; the generic `otherFiles` bucket still never leaks a raw "ID — " file.
- Purge helper: removes storage object + row + clears legacy fields; idempotent on a
  second call; (Drive path no-ops without creds).
- Cron selection: picks users at `placed_at+6mo` and `last_active+12mo`, and only those.
- Follow existing server/http-harness test idioms (no jsdom for page JS — test endpoints
  and pure logic functions).

## Security / privacy

- ID is sensitive PII (passport/licence). Drive copy stays private (`id_private`); CEO
  views via signed URL through the app. Viewing + deletion limited to **CEO / future ATS
  users only — RSOs excluded** (server-side `canViewIdentity` gate, not a UI hide).
- The retention promise shown to the GP is the consent basis; the purge routine makes it
  real (on request, silent 6-month-post-placement, 12-month inactivity).

## Key file touchpoints (from code map)

- Onboarding UI/handler: `pages/onboarding.html:1441-1485,1466-1467`; `js/onboarding.js:1549-1577`.
- Verify endpoint: `server.js:47394-47577`.
- Storage template: `saveAccountCareerDocumentForUser` `server.js:7269-7303`.
- Drive helpers: `server.js:807,820,840,909-923,941`; `lib/drive-doc-folders.js:35,42`.
- CEO documents: `server.js:51848,51880,51976-52001,52100-52104`; metas `server.js:6532,6555`.
- ATS candidate file: `js/ceo-ats-candidates.js:1417-1443`; flags `server.js:32557-32570,32811`.
- Purge/cron precedent: `account-deletion-feature` memory.
