# Handover — document auto-crop + the name-matching fix (2026-08-13)

**Status: everything below is SHIPPED to `main` and LIVE in production.** Two
commits, both deployed and verified:

| Commit | What | Deploy |
| --- | --- | --- |
| `ab6e485` | Document auto-crop at upload time (automatic + manual) | Vercel success, verified live |
| `935eef4` | Name-matching fix + staff crop of documents already on file | Vercel success, verified live |

Full test suite at the last push: **293 files / 5150 tests green.**

Written because the owner's editor glitched mid-session and had to be restarted.
Nothing here is in-flight or half-done; the "still open" items in §7 are
deliberate choices awaiting a decision, not unfinished work.

---

## 1. What the owner asked for

Three messages, in order:

1. *"alot of the GPs have background visible on their image uploads of
   qualifications including onboarding. can we have a crop feature that AI crops
   automatically so only the document is visible as well as manual if ai is not
   able to do it"* — with a screenshot of the staff review modal showing Dr
   Ibrahim Fashola's CCT certificate lying on a beige carpet.
2. *"so how can this be manually cropped then"* — about that same, already-stored
   document (the upload-time crop cannot reach it).
3. *"this document also needs cropping but the name is consistent between both
   documents so why is the name getting flagged"* — both of his qualifications
   were flagged with *"the name on this document looks like a previous name"*.

---

## 2. Part one — the crop (`ab6e485`)

### What a doctor now sees

A photographed document is trimmed to the document itself **before** it is
scanned or stored, in three steps:

1. **Automatic, locally, free, in milliseconds.** Otsu threshold + flood fill for
   the largest page-shaped region — run in **both polarities**, so a dark diploma
   on a pale desk works as well as a pale certificate on a dark one. (Single
   polarity was the obvious implementation and would have missed half the cases.)
2. **Automatic, with AI, only when the local pass cannot tell** (the classic case:
   a white certificate on a white table). One small vision call to the new
   `POST /api/ai/document-crop`, which returns a bounding box and nothing else.
3. **Manual, always available.** The crop sheet opens with the suggested box
   already drawn; the doctor drags the corners. This is also the confirmation
   step — nothing is trimmed on an uploaded file without them seeing it first.

### The rules that must NOT be "fixed" back

- **It never blocks an upload.** A HEIC the browser cannot decode, no canvas, AI
  down, nothing found → the **ORIGINAL** file goes through untouched. `prepare()`
  never rejects. A doctor who cannot get past a cosmetic crop cannot finish
  onboarding, and background in a photo is cosmetic.
- **It never trims into the document.** The detected page is padded outwards 2%,
  and a page whose region hugs >30% of any border (i.e. it runs off the photo)
  drops to **low confidence** so the sheet opens instead of cropping unattended.
- **No friction for the doctors who got it right.** A flat scan / screenshot
  (uniform pale border ring) or an already-tight photo is passed straight
  through with **no sheet at all**.
- **A camera capture is cropped quietly** (`origin: "camera"`). The camera already
  lined the page up in its A4 frame and made them confirm the shot; asking twice
  is the wrong UX.
- **No Escape-to-cancel in the sheet.** The scan modal has its own
  document-level Escape handler and one key press cannot be stopped from reaching
  both — Escape would cancel the crop *and* close the modal underneath it. The
  Cancel button is the way out.

### Where it lives

- `js/doc-crop.js` — the whole thing (`window.DocCrop`). Tunables sit between
  `/* ── tunables ──` and `/* ── end tunables ── */`; the test lifts that block so
  a threshold can never drift from the test that proves what it does.
  `prepare(file, opts)` is the only call sites make: resolves the file to upload
  (cropped **or the original**), or **null** when the doctor cancels — callers must
  treat null as "no file was picked" and undo whatever state they set.
- Wired into: `js/onboarding.js` (`handleDocVerification`, `handleIdVerification`
  — camera and upload), `js/qualification-scan.js` (`pickFile` → `showPickedFile`),
  `pages/my-documents.html` (`withDocCrop()` — prepared docs + police check),
  `pages/ahpra.html` (`handleIntroUpload` / `handleAhpraUpload` wrappers in front
  of `…UploadFile`). The crop runs **before** the file is prepared, so the AI scan,
  the stored copy and the copy AHPRA receives are all the cropped document.
- **Not** wired: `pages/pbs.html`, `pages/commencement.html` (provider PDFs, not
  photographed qualifications). One line each if the owner wants them.
- Loading: eager `<script src="js/doc-crop.js?v=20260813a">` on onboarding /
  my-documents / ahpra / admin / ceo-dashboard; `ensureDocCrop()` in
  `js/qualification-scan.js` lazy-injects it on the other 13 pages that carry the
  scan modal. A test keeps the loader's buster in step with the page tags.
- `POST /api/ai/document-crop` (server.js) + `sanitizeAiCropBox()` next to
  `applyPhotoFramingPolicy`.

### The endpoint's deliberate choices

- It does **NOT** call `checkUserAiLimit`. That counter is the doctor's small daily
  allowance of document **verification** attempts; working out where the edges of a
  page are must never spend one. Own key `doc-crop:<email>`, 80/day.
- `DOC_CROP_MODEL` env, defaults to `ANTHROPIC_SCAN_MODEL`. **Sends no
  `temperature`** — Opus 4.7/4.8 and Sonnet 5 reject it with a 400.
- Every soft failure answers **200 `found:false`** so the doctor just crops by
  hand. That is a normal outcome, not an error.
- `sanitizeAiCropBox` re-checks and pads every box the model returns: percentages
  accepted, minimum side 0.15, area 0.05–0.95 (a box covering the whole picture
  means "nothing to trim" → null).

---

## 3. Part two — the name-matching fix (`935eef4`)

### The bug

Both of Dr Fashola's qualifications said *"The name on this document looks like a
previous name"* **and** *"Names on your specialist qualification and medical
degree do not match each other"* — for a name that is his on all three. That
wording is **emailed to the doctor** and creates a manual RSO review task, so a
false positive is expensive twice.

The matcher required **the FIRST word and the LAST word to match exactly**. Proven
by running the real functions on the real strings the scan read:

| source | text | normalized words |
| --- | --- | --- |
| account | `Ibrahim Fashola` | `[ibrahim, fashola]` |
| CCT | `Fashola, Ademola Kelil Ilrahim` | `[fashola, ademola, kelil, ilrahim]` |
| degree | `Ademola-Keji Ibrahim A. Fashola` | `[ademola, keji, ibrahim, a, fashola]` |

Three independent breakages:

1. The GMC prints the name **surname-first with a comma**, and the comma was
   stripped with all other punctuation → "Fashola" read as his first name.
2. On the degree, the name he **goes by is a middle name** → the first word could
   never be "Ibrahim".
3. The scan read "Kelil Ilrahim" for "Keji Ibrahim" — **a letter out**, which an
   exact comparison can never forgive.

### The rule now

A single leading comma is understood as surname-first (`reorderCommaName`); the
**surname must be present in full** somewhere in the other name (checked from
**both** sides, because only the account name is reliably surname-last); and **at
least two words must correspond** wherever they sit — matching exactly, as an
initial, or with **one letter of edit distance on words of 5+ letters**
(`nameWordsMatch` / `countMatchedNameWords`).

### 🚨 Read before loosening this any further

`crossCheckDocumentName` → `matchNames` is **also the wrong-owner guard** for CVs
and email attachments. A CV filed under the wrong doctor becomes a PII breach the
moment it is emailed to a practice — this actually happened (Sana Ahsan's CV under
Helen Wazalski's account). Every relaxation above is about word **order**,
initials and OCR slips, **never** about letting a different surname through.
Pinned as still `mismatch` by tests:

- a different doctor entirely (`Sana Ahsan` vs `Helen Wazalski`);
- a relative sharing the surname (`Ademola Fashola` vs `Ibrahim Fashola`);
- a changed surname (`Mary Jane Smith` vs `Mary Jane Jones`) — that is the
  name-change path, not a match;
- `Jane`/`Jade` and `Khan`/`Khun` — four letters and one apart is a **different
  name**, not a misread, which is why the OCR fuzz has a five-letter floor;
- a surname on its own with nothing else to corroborate it;
- `Smith, MBBS` must **not** reorder into "MBBS Smith" — a comma followed only by
  qualification noise is left alone.

### Two copies, deliberately

`js/onboarding.js` has no imports, so the wizard carries its own copy (it is the
one that decides whether a doctor's two certificates agree with each other).
`tests/name-matching.test.js` lifts the wizard's copy out of the source and
asserts it returns the **same** level as the server's across 15 cases. Drift means
the wizard and the scan disagree about whether a doctor's own certificate is
theirs.

Also fixed in passing: `autoUpdateAccountName` split on whitespace, so a
surname-first document name would have written the account's first name as
`"Fashola,"`.

---

## 4. Part three — staff can crop a document already on file (`935eef4`)

The upload-time crop cannot reach anything uploaded before it shipped — including
documents about to be sent to AHPRA. There was no way to fix one except rejecting
a perfectly good certificate to get a tidier photograph of it.

**"✂️ Crop out the background"** now appears under the document in the review
modal of **both** staff consoles:

- `pages/admin.html` → `cropReviewDocImage()` (⚠️ the screen titled *"CEO Command
  Centre"* **is admin.html** — `topTitle` switches on `isSA()`);
- `pages/ceo-dashboard.html` → `ceoCropReviewDoc()`.

It opens the same shared sheet, in the new **`force: true`** mode, which skips the
"nothing to trim" short-circuits — staff are looking at the picture and can see
background the detector thinks is fine. Only shown for images (nothing to crop on
a PDF).

`POST /api/admin/va/task/crop-document` **overwrites** the stored document, so it:

- keeps the original **once**, beside it, at `<path>.precrop-<YYYYMMDDHHMMSS>`,
  written **before** the overwrite;
- 🧨 **replaces the Google Drive mirror's CONTENT in place**
  (`replaceGoogleDriveFileContent`). `reconcileGpDrive` skips any `user_documents`
  row that already has a `google_drive_file_id`, so overwriting Storage alone
  would leave Drive — and anything sent on from it — showing the uncropped
  picture **forever**;
- deletes `metadata.ai_scan` (it judged the old picture) with the rest of the task
  metadata **merged, not replaced**, then the panel re-scans the clean image;
- proves the bytes really are the image type they claim (JPEG/PNG magic bytes),
  refuses a PDF, and caps the size;
- leaves the review status, file name and decision **untouched** — this changes
  the picture, not the decision;
- resolves the file through the new shared `resolveTaskDocumentStorage(task)`,
  the same resolution the preview and the AI scan use.

### 🧨 A third copy of the onboarding key map — with entries missing

While wiring the resolver, a **third** hand-written copy of the onboarding
document-key map turned up (in `review-flagged-doc`), and it was **missing the
three `onboarding_*` self-aliases** the other two had. So approving a task already
keyed `onboarding_cct_certificate` resolved to no file and filed the approval
record with **no document attached**. All three now use one
`ONBOARDING_DOC_KEY_ALIASES`; a test counts the uses and asserts the old names are
gone.

---

## 5. What the owner needs to do

1. **Clear Dr Fashola's two name flags:** open each document in the review modal
   and click **"Re-scan"**. It recomputes the name match with the new rule and
   should now read *"matches the account"*. No re-upload, nothing to ask him for.
   Then Approve.
2. **Crop his two documents:** the ✂️ button under the document. Drag the corners,
   "Use this crop". The original is kept as a copy either way.
3. **Watch one white-on-white case** if you want to see the AI crop fallback: a
   certificate photographed on a *white* table. The local detector gives up, the
   sheet shows "Looking for the document…", then the box should snap on.

---

## 6. How this was verified (and what that does not cover)

- **Full suite 293 files / 5150 green**, plus `node --check` on every changed file
  **and on the inline `<script>` blocks of all five changed pages** (the page tests
  only grep — they never parse).
- **The detector was executed, not grepped**: `tests/doc-auto-crop.test.js` lifts
  it out of the real source and runs it against synthetic frames (carpet,
  dark-on-pale, flat scan, clutter, already-full-frame, runs-off-the-edge).
- **A real browser** (headless Chrome + a synthetic "certificate on a carpet" at a
  known position) proved: the detector lands **within 0.3%** of the true page on
  all four edges; the sheet's canvas equals the displayed image (a letterboxed
  image would put the box off the pixels); the corner drag works; the output
  file's dimensions match the box exactly; the camera path crops with no sheet; a
  flat scan comes back as the *same file object*; and `force` mode opens the sheet
  on a photo the detector would have skipped.
- **The staff endpoint was driven against the real server**
  (`tests/staff-crop-stored-document.test.js`, 9 tests, Supabase emulator + a
  hand-minted `gp_admin_session` cookie, recording every storage call): the crop
  lands on the same object the preview reads, the backup precedes the overwrite,
  metadata is merged, and a PDF / mislabelled bytes / no session are all refused.

**Not covered, stated plainly:**

- The staff crop has **not** been run against a real document in production — that
  overwrites live data, so the owner's first use is the first real one. (The
  original is always kept as a copy.)
- The **AI crop fallback has never been seen answering for real.** It is built,
  and every box it returns is re-checked and padded, but no live model response
  has been observed. The local detector handles the ordinary cases and the
  fallback only runs when it cannot tell.
- An unauthenticated probe of `/api/admin/va/task/crop-document` returns 404 by
  design (admin routes hide themselves), so **a 404 probe proves nothing** about
  whether it shipped. What proves it: the deployed SHA contains the route, and the
  functional test drives it.

---

## 7. Still open (decisions, not unfinished work)

- **pbs.html / commencement.html** are not wired into the crop (provider PDFs).
- **`DOC_CROP_MODEL`** defaults to the scan model (Opus-class). If the AI fallback
  ever feels slow, that is one env var to a faster model.
- **Photo/PDF auto-decide remain OFF** (`DOC_PIPELINE_PHOTO_AUTO_DECIDE`,
  `DOC_PIPELINE_PDF_AUTO_DECIDE`) — unchanged by this work, still awaiting the
  owner watching real verdicts.
- Anything a doctor **re-uploads** after an RSO rejection now gets cropped on the
  way in, so the backlog partly self-heals.

---

## 8. Memory written for future sessions

Under `~/.claude/projects/-Users-gplinkrecruitment-Downloads-GP-LINK-APP--Visual-Studio--copy/memory/`:

- `document-auto-crop.md` — the crop feature, its rules, and the browser harness
  recipe (⚠️ port 8712 was already taken by another parallel job; use a port you
  have just proven free and check the server log for an `EADDRINUSE` dump before
  believing a 404).
- `name-matching-first-last-word-trap.md` — the name bug, the new rule, and the
  security line that must not be crossed.

Both are indexed in that directory's `MEMORY.md`.
