# AHPRA Change-of-Representative (ANOM-00) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate changing a doctor's AHPRA authorised representative (the ANOM-00 form) when a mid-AHPRA case is reassigned to a new registration officer (RSO).

**Architecture:** New RSO signs a pre-filled ANOM-00 Section B in-app (canvas signature) → doctor completes Section A + authorisations + signs on an in-app page → `pdf-lib` overlays both onto the flat official template → the finished form is emailed to the case's assigned AHPRA officer → the per-case "pinned rep mailbox" flips to the new RSO only when AHPRA confirms. A first-run RSO onboarding step captures name + AHPRA-account confirmation (company email is provisioned + locked).

**Tech Stack:** Node `http` server (`server.js`), vanilla HTML/JS pages, Supabase (PostgREST + `rpc/exec_sql`), `pdf-lib` (^1.17.1), vitest.

**Spec:** `docs/superpowers/specs/2026-07-02-ahpra-rep-change-anom00-design.md`
**UI source of truth:** `docs/mockups/anom00-rep-change-prototype.html` (open in a browser; deep-links `#s1`…`#s9`).

## Global Constraints

- **No system node.** Use `/tmp/node-v20.18.1-darwin-arm64/bin/node`. Vitest: `$NODE node_modules/vitest/vitest.mjs run`. Syntax: `$NODE --check server.js`.
- **Full suite must stay green** (baseline ~894 tests). Run before every push.
- **Commit + push after every task** (CLAUDE.md rule 6). Push via `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push`.
- **Task-type constraint has DRIFTED in prod** — read the LIVE constraint via `rpc/exec_sql` before rebuilding; never trust migration files for the current set (memory `sppa-alt-supervisor-cv-request`).
- **DDL** goes to prod via `rpc/exec_sql` (service key from `.env`, NOT `.env.prod`) AND is committed as a migration.
- **Company email for an AHPRA rep must be `@mygplink.com.au`** (domain-wide delegation only impersonates that domain).
- **Submission recipient** = `registration_cases.ahpra_officer_email` (dynamic), fallback `authreps@ahpra.gov.au`. Do NOT alter the government PDF's printed footer.
- **Cache-buster** on any changed script/style tag: `?v=20260702a`.
- Sample data for tests/manual: doctor "Dr Smith Miller", old RSO "Hazel", new RSO "Ben Carter" `ben@mygplink.com.au`, officer "Jane Whitfield" `j.whitfield@ahpra.gov.au`, org `GP LINK RECRUITMENT AUSTRALIA PTY LTD`, `SUITE 3050, 780 THE ENTRANCE RD, WAMBERAL NSW`.

---

## File Structure

- **Create** `lib/anom00.js` — pure ANOM-00 fill engine (data + 2 PNG buffers → PDF bytes) + `ANOM00_FIELDS` coordinate map.
- **Create** `assets/anom00-template.pdf` — the official flat form (copied from the owner's file).
- **Create** `js/signature-pad.js` — reusable canvas signature capture (attach → PNG data URL).
- **Create** `pages/ahpra-rep-change.html` — the doctor's in-app completion + review/send page.
- **Create** `supabase/migrations/20260702120000_ahpra_rep_change.sql` — DDL (record of what exec_sql applied).
- **Create** `tests/anom00.test.js`, `tests/ahpra-rep-change.test.js` — unit tests.
- **Modify** `server.js` — new columns wiring, `task_type`, endpoints, auto-trigger, sender-purpose routing.
- **Modify** `pages/admin.html` — RSO onboarding modal + `ahpra_rep_change` task card renderer.
- **Modify** `vercel.json` if needed — ensure `assets/anom00-template.pdf` is bundled (`includeFiles`).

---

## Task 1: Data model + `ahpra_rep_change` task type

**Files:**
- Create: `supabase/migrations/20260702120000_ahpra_rep_change.sql`
- Create: `tests/ahpra-rep-change.test.js` (first cases)
- Modify: `server.js` (any hardcoded task-type allowlist, if present — grep `ahpra_correspondence` to find it)

**Interfaces:**
- Produces: `rso_team` columns `first_name,last_name,company_email,ahpra_account_confirmed,ahpra_account_confirmed_at,onboarding_completed_at`; `registration_cases` columns `ahpra_auth_rep_email,ahpra_auth_rep_user_id,ahpra_auth_rep_confirmed_at`; task type `ahpra_rep_change`.

- [ ] **Step 1: Read the LIVE task_type constraint** (do NOT trust migration files)

Run (service key from `.env`):
```bash
NODE=/tmp/node-v20.18.1-darwin-arm64/bin/node
SVC=$(grep -m1 -oE '^SUPABASE_SERVICE_ROLE_KEY=.+' .env | cut -d= -f2-)
URL=$(grep -m1 -oE '^SUPABASE_URL=.+' .env | cut -d= -f2-)
curl -s "$URL/rest/v1/rpc/exec_sql" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json" \
  -d '{"query":"select pg_get_constraintdef(oid) from pg_constraint where conname='"'"'registration_tasks_task_type_check'"'"'"}'
```
Expected: the current `CHECK (task_type IN (...))` list. Copy the exact list.

- [ ] **Step 2: Write the migration file** `supabase/migrations/20260702120000_ahpra_rep_change.sql`

Contents (union the LIVE list from Step 1 with `'ahpra_rep_change'`; add columns idempotently):
```sql
-- rso_team profile fields for AHPRA representative onboarding
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS company_email text;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS ahpra_account_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS ahpra_account_confirmed_at timestamptz;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

-- per-case pinned AHPRA representative mailbox
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_auth_rep_email text;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_auth_rep_user_id uuid;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_auth_rep_confirmed_at timestamptz;

-- backfill company_email from email when already @mygplink.com.au
UPDATE rso_team SET company_email = email
  WHERE company_email IS NULL AND email ILIKE '%@mygplink.com.au';

-- task type (REPLACE the IN-list below with the LIVE list from Step 1 + the new value)
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN ( /* <LIVE LIST> */ , 'ahpra_rep_change' ));
```

- [ ] **Step 3: Apply to prod via exec_sql**, statement by statement (exec_sql returns void)

Run each statement through `rpc/exec_sql` as in Step 1. For the constraint, verify after:
```bash
# re-run the pg_get_constraintdef query — expect 'ahpra_rep_change' now present
```
Expected: constraint definition now includes `'ahpra_rep_change'`; columns exist (spot-check `select company_email from rso_team limit 1` returns 200).

- [ ] **Step 4: Write a test asserting the migration + allowlist include the new type**

`tests/ahpra-rep-change.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('ahpra_rep_change plumbing', () => {
  it('migration adds the task type and the new columns', () => {
    const sql = readFileSync('supabase/migrations/20260702120000_ahpra_rep_change.sql', 'utf8');
    expect(sql).toContain("'ahpra_rep_change'");
    expect(sql).toMatch(/ahpra_auth_rep_email/);
    expect(sql).toMatch(/company_email/);
    expect(sql).toMatch(/ahpra_account_confirmed/);
  });
});
```
If `server.js` has an in-code task-type allowlist (grep `ahpra_correspondence`), add `'ahpra_rep_change'` and assert it here too.

- [ ] **Step 5: Run the test + syntax check**

Run: `$NODE node_modules/vitest/vitest.mjs run tests/ahpra-rep-change.test.js` → PASS. `$NODE --check server.js` → OK.

- [ ] **Step 6: Commit**
```bash
git add supabase/migrations/20260702120000_ahpra_rep_change.sql tests/ahpra-rep-change.test.js server.js
git commit -m "feat(anom00): data model + ahpra_rep_change task type (applied via exec_sql)"
```

---

## Task 2: `lib/anom00.js` — ANOM-00 fill engine

**Files:**
- Create: `assets/anom00-template.pdf` (copy: `cp "/Users/gplinkrecruitment/Downloads/ANOM-00 .pdf" assets/anom00-template.pdf`)
- Create: `lib/anom00.js`
- Create: `tests/anom00.test.js`

**Interfaces:**
- Produces:
  - `buildAnom00({ mode, applicant, rep, authorisations, dates }, { repSignaturePng, gpSignaturePng }) -> Promise<Uint8Array>` where `mode ∈ {'rep_only','full'}`.
  - `applicant = { title, familyName, firstName, middleName, dob, email }`
  - `rep = { fullName, orgName, address, city, state, postcode, country, phone, mobile, email, hasAhpraAccount }`
  - `authorisations = { communicate:bool, act:bool, receive:bool, authorises:bool }`
  - `ANOM00_FIELDS` (exported coordinate map).
- Consumes: `assets/anom00-template.pdf`, `pdf-lib`.

- [ ] **Step 1: Write failing tests** `tests/anom00.test.js`
```js
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildAnom00 } from '../lib/anom00.js';

const applicant = { title:'DR', familyName:'MILLER', firstName:'SMITH', middleName:'JOHN', dob:'14/03/1989', email:'dr.smith.miller@example.com' };
const rep = { fullName:'BEN CARTER', orgName:'GP LINK RECRUITMENT AUSTRALIA PTY LTD', address:'SUITE 3050, 780 THE ENTRANCE RD', city:'WAMBERAL', state:'NSW', postcode:'2260', country:'AUSTRALIA', phone:'', mobile:'', email:'ben@mygplink.com.au', hasAhpraAccount:true };
const auth = { communicate:true, act:true, receive:true, authorises:true };
// tiny 1x1 png
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');

describe('buildAnom00', () => {
  it('rep_only mode returns a 3-page PDF and embeds the rep signature', async () => {
    const bytes = await buildAnom00({ mode:'rep_only', applicant, rep, authorisations:auth, dates:{ rep:'01/07/2026' } }, { repSignaturePng: PNG });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(3);
    expect(bytes.length).toBeGreaterThan(1000);
  });
  it('full mode embeds both signatures', async () => {
    const bytes = await buildAnom00({ mode:'full', applicant, rep, authorisations:auth, dates:{ rep:'01/07/2026', gp:'01/07/2026' } }, { repSignaturePng: PNG, gpSignaturePng: PNG });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(3);
  });
  it('throws if a required signature is missing for the mode', async () => {
    await expect(buildAnom00({ mode:'full', applicant, rep, authorisations:auth, dates:{} }, { repSignaturePng: PNG })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `$NODE node_modules/vitest/vitest.mjs run tests/anom00.test.js` → FAIL (module not found).

- [ ] **Step 3: Copy the template + implement `lib/anom00.js`**
```bash
cp "/Users/gplinkrecruitment/Downloads/ANOM-00 .pdf" assets/anom00-template.pdf
```
```js
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'anom00-template.pdf');

// Coordinate map — origin bottom-left, points. CALIBRATE against the template
// (render → screenshot → adjust). Page indices are 0-based. Start values below
// are approximate and MUST be tuned in Step 4.
const ANOM00_FIELDS = {
  // page 1 — Section A
  familyName: { page:0, x:250, y:632, size:11 },
  firstName:  { page:0, x:250, y:600, size:11 },
  middleName: { page:0, x:250, y:568, size:11 },
  dob:        { page:0, x:250, y:505, size:11 },
  regNo_x:    { page:1, x:250, y:775, size:12 }, // "No" box on p2 top (Q2)
  email_applicant: { page:1, x:250, y:620, size:10 },
  // page 2 — Section B
  hasAccount_x: { page:1, x:250, y:560, size:12 },
  legalName:  { page:1, x:250, y:470, size:10 },
  repName:    { page:1, x:250, y:435, size:10 },
  orgName:    { page:1, x:250, y:405, size:9 },
  address:    { page:1, x:250, y:378, size:9 },
  city:       { page:1, x:250, y:330, size:9 },
  state:      { page:1, x:250, y:300, size:9 },
  postcode:   { page:1, x:430, y:300, size:9 },
  country:    { page:1, x:250, y:270, size:9 },
  repEmail:   { page:1, x:250, y:150, size:9 },
  // page 3 — signatures + Q6
  repSig:     { page:2, x:330, y:735, w:150, h:44 },
  repDate:    { page:2, x:90,  y:760, size:11 },
  authorises_x:{ page:2, x:250, y:640, size:12 },
  auth_communicate_x:{ page:2, x:70, y:590, size:11 },
  auth_act_x: { page:2, x:70, y:545, size:11 },
  auth_receive_x:{ page:2, x:70, y:500, size:11 },
  gpSig:      { page:2, x:330, y:250, w:150, h:44 },
  gpDate:     { page:2, x:90,  y:275, size:11 },
};

async function buildAnom00(data, sigs) {
  const { mode, applicant, rep, authorisations, dates } = data;
  if (!applicant || !rep) throw new Error('anom00: applicant and rep required');
  if (!sigs || !sigs.repSignaturePng) throw new Error('anom00: rep signature required');
  if (mode === 'full' && !sigs.gpSignaturePng) throw new Error('anom00: gp signature required for full mode');

  const pdf = await PDFDocument.load(readFileSync(TEMPLATE));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const ink = rgb(0.05, 0.14, 0.35);
  const put = (key, text) => {
    const f = ANOM00_FIELDS[key]; if (!f || text == null || text === '') return;
    pages[f.page].drawText(String(text), { x:f.x, y:f.y, size:f.size, font, color:ink });
  };
  const mark = (key) => { const f = ANOM00_FIELDS[key]; if (!f) return; pages[f.page].drawText('X', { x:f.x, y:f.y, size:f.size, font, color: rgb(0.78,0.15,0.15) }); };

  // Section A (applicant)
  put('familyName', applicant.familyName); put('firstName', applicant.firstName);
  put('middleName', applicant.middleName); put('dob', applicant.dob);
  mark('regNo_x'); put('email_applicant', applicant.email);
  // Section B (rep)
  if (rep.hasAhpraAccount) mark('hasAccount_x');
  put('legalName', [applicant.firstName, applicant.middleName, applicant.familyName].filter(Boolean).join(' '));
  put('repName', rep.fullName); put('orgName', rep.orgName); put('address', rep.address);
  put('city', rep.city); put('state', rep.state); put('postcode', rep.postcode);
  put('country', rep.country); put('repEmail', (rep.email||'').toUpperCase());
  put('repDate', dates && dates.rep);

  const drawSig = async (key, png) => {
    const f = ANOM00_FIELDS[key]; const img = await pdf.embedPng(png);
    const scale = Math.min(f.w / img.width, f.h / img.height);
    pages[f.page].drawImage(img, { x:f.x, y:f.y, width:img.width*scale, height:img.height*scale });
  };
  await drawSig('repSig', sigs.repSignaturePng);

  if (mode === 'full') {
    if (authorisations && authorisations.authorises) mark('authorises_x');
    if (authorisations && authorisations.communicate) mark('auth_communicate_x');
    if (authorisations && authorisations.act) mark('auth_act_x');
    if (authorisations && authorisations.receive) mark('auth_receive_x');
    put('gpDate', dates && dates.gp);
    await drawSig('gpSig', sigs.gpSignaturePng);
  }
  return pdf.save();
}

module.exports = { buildAnom00, ANOM00_FIELDS };
```
(If the repo uses ESM in `lib/`, match the existing module style — check a sibling like `lib/drive-doc-folders.js`.)

- [ ] **Step 4: Calibrate coordinates** (write a throwaway harness in `$CLAUDE_JOB_DIR/tmp`)

Fill with sample data, save to a temp PDF, render with headless Chrome (`--screenshot`), compare to `assets/anom00-template.pdf`, and adjust `ANOM00_FIELDS` until each value sits in its box. Repeat until visually correct. (This is the flat-form tax; budget real iteration.)

- [ ] **Step 5: Run tests**

Run: `$NODE node_modules/vitest/vitest.mjs run tests/anom00.test.js` → PASS (all 3).

- [ ] **Step 6: Ensure the asset is bundled + commit**

Check `vercel.json` `functions`/`includeFiles`; if PDFs under `assets/` aren't already included, add `assets/**`. Then:
```bash
git add assets/anom00-template.pdf lib/anom00.js tests/anom00.test.js vercel.json
git commit -m "feat(anom00): pdf-lib fill engine + calibrated field map + template asset"
```

---

## Task 3: Signature pad component

**Files:**
- Create: `js/signature-pad.js`
- Test: manual (canvas) + a pure helper unit test.

**Interfaces:**
- Produces (global, no bundler): `window.GPSignaturePad.attach(canvasEl, { onChange })` → `{ isEmpty(), toPNG(), clear() }`. `toPNG()` returns a trimmed `data:image/png` string (or `''` if empty).

- [ ] **Step 1: Implement `js/signature-pad.js`** (pointer + touch, DPR-aware, trim to ink bounds). Base it on the prototype's `initPad`/signature code in `docs/mockups/anom00-rep-change-prototype.html` (already working). Expose the interface above; `toPNG()` crops to drawn bounds with padding.

- [ ] **Step 2: Add a pure helper + test** — factor the bounds-trim math into `trimBounds(imageDataLike)` and test it in `tests/ahpra-rep-change.test.js`:
```js
import { trimBounds } from '../js/signature-pad.js'; // export the pure helper for node
// given a mock {width,height,data} with a single opaque pixel at (2,3), expect bounds {minX:2,minY:3,maxX:2,maxY:3}
```
Guard the DOM parts so `require`ing in node doesn't touch `window` (`if (typeof window !== 'undefined') { ... }`).

- [ ] **Step 3: Run test** → PASS. Manual: open the prototype, confirm drawing + Clear + PNG output still work (this file is extracted from it).

- [ ] **Step 4: Commit**
```bash
git add js/signature-pad.js tests/ahpra-rep-change.test.js
git commit -m "feat(anom00): reusable canvas signature pad + trim helper"
```

---

## Task 4: RSO first-run onboarding (Component A)

**Files:**
- Modify: `server.js` (3 endpoints + a `rsoOnboardingStatus` helper)
- Modify: `pages/admin.html` (first-run modal — mirror prototype `#s1`; locked email; gate)
- Test: `tests/ahpra-rep-change.test.js`

**Interfaces:**
- Produces: `rsoNeedsOnboarding(rsoRow) -> bool` (true when `!onboarding_completed_at` OR missing first/last name); `rsoCanBeAhpraRep(rsoRow) -> bool` (true when `ahpra_account_confirmed === true` AND `company_email` ends `@mygplink.com.au`). Both exported on `module.exports.__testUtils`.
- Endpoints: `GET /api/admin/rso/onboarding-status`, `POST /api/admin/rso/onboarding`, `POST /api/admin/rso/company-email` (super-admin only).

- [ ] **Step 1: Write failing tests** for the two predicates in `tests/ahpra-rep-change.test.js`:
```js
import server from '../server.js'; // or however __testUtils is exposed — match existing pattern (grep "__testUtils")
const { rsoNeedsOnboarding, rsoCanBeAhpraRep } = server.__testUtils;
it('rso needs onboarding when name missing', () => {
  expect(rsoNeedsOnboarding({ onboarding_completed_at:null })).toBe(true);
  expect(rsoNeedsOnboarding({ onboarding_completed_at:'2026-07-02', first_name:'Ben', last_name:'Carter' })).toBe(false);
});
it('rso can be AHPRA rep only when confirmed + mygplink email', () => {
  expect(rsoCanBeAhpraRep({ ahpra_account_confirmed:true, company_email:'ben@mygplink.com.au' })).toBe(true);
  expect(rsoCanBeAhpraRep({ ahpra_account_confirmed:true, company_email:'ben@gmail.com' })).toBe(false);
  expect(rsoCanBeAhpraRep({ ahpra_account_confirmed:false, company_email:'ben@mygplink.com.au' })).toBe(false);
});
```
(First grep `__testUtils` in server.js to match the existing export mechanism.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** the two pure predicates + the three endpoints in `server.js` (read the admin-auth middleware + an existing `/api/admin/...` handler first to match the routing/response pattern; RSO identity comes from the admin session → roster row). `POST /api/admin/rso/company-email` requires super-admin and validates `@mygplink.com.au`.

- [ ] **Step 4: Run predicate tests → PASS**; `$NODE --check server.js` → OK.

- [ ] **Step 5: Build the modal** in `pages/admin.html` — on load, call `onboarding-status`; if needed, show the first-run modal (copy markup/styles from prototype `#s1`: first/last name inputs, **locked read-only company email**, AHPRA-account checkbox, Save). Save posts to `/api/admin/rso/onboarding`. Bump the script cache-buster.

- [ ] **Step 6: Commit**
```bash
git add server.js pages/admin.html tests/ahpra-rep-change.test.js
git commit -m "feat(anom00): RSO first-run onboarding (locked company email + AHPRA-account gate)"
```

---

## Task 5: RSO ANOM-00 task card + send + confirm (Components D2, D6)

**Files:**
- Modify: `server.js` (2 endpoints)
- Modify: `pages/admin.html` (task-type `ahpra_rep_change` renderer — mirror prototype `#s3`, `#s3b`, `#s4`)
- Test: `tests/ahpra-rep-change.test.js`

**Interfaces:**
- Consumes: `buildAnom00` (Task 2), `rsoCanBeAhpraRep` (Task 4), `GPSignaturePad` (Task 3).
- Produces:
  - `POST /api/admin/va/task/:id/anom00-send-to-gp` — body `{ repSignaturePng }`; validates gate, builds `mode:'rep_only'` PDF, stores it, emails the doctor with a deep link, sets `metadata.rep_change_state='waiting_on_gp'`.
  - `POST /api/admin/va/task/:id/anom00-confirmed` — sets `registration_cases.ahpra_auth_rep_email/_user_id/_confirmed_at` from the task's `new_rso_user_id` + that RSO's `company_email`; task → `completed`.
  - `buildRepSectionData(caseRow, rsoRow) -> {applicant, rep}` (pure; exported) assembling Section A/B values from the case + RSO profile + company constants.

- [ ] **Step 1: Write failing test** for `buildRepSectionData` (pure): given a case row (doctor names/dob/email) + rso row (name/company_email), returns `rep.email === rso.company_email`, `rep.orgName === 'GP LINK RECRUITMENT AUSTRALIA PTY LTD'`, `rep.hasAhpraAccount === true`, and applicant fields mapped. Add to `tests/ahpra-rep-change.test.js`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `buildRepSectionData` + the two endpoints (read an existing `/api/admin/va/task/:id/...` handler — e.g. the alt-supervisor-cv or ahpra-deliver-to-gp endpoint — to match auth, task lookup, `task_documents`/`task_messages`, and the doctor-email helper `sendGpNotificationEmail`). The `send-to-gp` email reuses existing send infra (shared hub + RSO name, per spec §3) and deep-links to `pages/ahpra-rep-change.html?token=...`.

- [ ] **Step 4: Run test → PASS**; `$NODE --check server.js` → OK.

- [ ] **Step 5: Build the card renderer** in `pages/admin.html` for `task_type === 'ahpra_rep_change'`: pre-filled Section B summary, embedded signature pad, gate 3b when `!rsoCanBeAhpraRep`, **Send to GP**, and (post-send) the **Confirmed by AHPRA** button. Mirror prototype `#s3/#s3b/#s4`. Wire buttons to the two endpoints.

- [ ] **Step 6: Commit**
```bash
git add server.js pages/admin.html tests/ahpra-rep-change.test.js
git commit -m "feat(anom00): RSO task card — sign, send to GP, confirm + pin flip"
```

---

## Task 6: Auto-trigger on reassignment (Component D1)

**Files:**
- Modify: `server.js` (reassignment path — grep `assigned_va` PATCH handler, ~server.js:307-360 area / `/api/admin/ops/case`)
- Test: `tests/ahpra-rep-change.test.js`

**Interfaces:**
- Produces: `shouldTriggerRepChange(prevCase, nextAssignedVa) -> bool` (pure, exported): true iff assignee actually changes AND `prevCase.stage ∈ {ahpra,career,pbs,commencement}` AND (`prevCase.ahpra_officer_email` set OR `prevCase.ahpra_auth_rep_email` set). Plus `_ensureRepChangeTask(caseId, prevRsoId, newRsoId)` — idempotent (no open `ahpra_rep_change` task already).

- [ ] **Step 1: Write failing tests** for `shouldTriggerRepChange`:
```js
const { shouldTriggerRepChange } = server.__testUtils;
it('fires only for a real reassignment of a mid-AHPRA case with an officer', () => {
  const base = { stage:'ahpra', assigned_va:'old', ahpra_officer_email:'j@ahpra.gov.au' };
  expect(shouldTriggerRepChange(base, 'new')).toBe(true);
  expect(shouldTriggerRepChange(base, 'old')).toBe(false);           // no change
  expect(shouldTriggerRepChange({ ...base, ahpra_officer_email:null, ahpra_auth_rep_email:null }, 'new')).toBe(false); // no rep yet
  expect(shouldTriggerRepChange({ ...base, stage:'amc' }, 'new')).toBe(false); // not mid-AHPRA
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `shouldTriggerRepChange` + `_ensureRepChangeTask`, and call them inside the reassignment handler AFTER the assignee is persisted (read the handler first; it already fetches the old `assigned_va` and resolves the new RSO). Create the task with `task_type:'ahpra_rep_change'`, `metadata:{ rep_change_state:'awaiting_rso_sign', prev_rso_user_id, new_rso_user_id, source_reassignment:true }`, assigned to the new RSO.

- [ ] **Step 4: Run tests → PASS**; `$NODE --check server.js` → OK.

- [ ] **Step 5: Commit**
```bash
git add server.js tests/ahpra-rep-change.test.js
git commit -m "feat(anom00): auto-create rep-change task on mid-AHPRA reassignment"
```

---

## Task 7: Doctor email + in-app page + submit/send (Components D3–D5)

**Files:**
- Create: `pages/ahpra-rep-change.html` (mirror prototype `#s6/#s7/#s8`)
- Modify: `server.js` (3 endpoints)
- Test: `tests/ahpra-rep-change.test.js`

**Interfaces:**
- Consumes: `buildAnom00` (full mode), `GPSignaturePad`, task token from Task 5's email.
- Produces:
  - `GET /api/ahpra/rep-change/:token` → `{ applicant, repName }` (prefilled Section A).
  - `POST /api/ahpra/rep-change/:token/submit` → body `{ gpSignaturePng, authorisations }`; builds full PDF, stores it, `metadata.rep_change_state='ready_to_send'`.
  - `POST /api/ahpra/rep-change/:token/send` → emails the finished PDF to `resolveAhpraSubmissionRecipient(caseRow)`; `metadata.rep_change_state='waiting_on_ahpra'`.
  - `resolveAhpraSubmissionRecipient(caseRow) -> email` (pure, exported): `caseRow.ahpra_officer_email || 'authreps@ahpra.gov.au'`.

- [ ] **Step 1: Write failing test** for `resolveAhpraSubmissionRecipient`:
```js
const { resolveAhpraSubmissionRecipient } = server.__testUtils;
it('sends to the assigned officer, else authreps fallback', () => {
  expect(resolveAhpraSubmissionRecipient({ ahpra_officer_email:'j.whitfield@ahpra.gov.au' })).toBe('j.whitfield@ahpra.gov.au');
  expect(resolveAhpraSubmissionRecipient({})).toBe('authreps@ahpra.gov.au');
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** the three endpoints + `resolveAhpraSubmissionRecipient`. Token = a signed/opaque ref to the task (reuse the app's existing deep-link/token pattern — grep how `?doc=` deep links or task tokens are minted). The `/send` handler builds the recipient, attaches the stored full PDF, and sends per spec §3 default (**server-sends from the new RSO's rep mailbox, Reply-To = doctor, CC doctor + RSO** — CONFIRM owner's choice on the flagged decision before finalizing; leave a clear `// OWNER-DECISION` marker). Fallback `authreps@` when no officer.

- [ ] **Step 4: Build `pages/ahpra-rep-change.html`** — dark hero + prefilled Section A + 3 authorisation checkboxes + signature pad (`GPSignaturePad`) + Build → review (PDF summary) → **Send to AHPRA** → success. Mirror prototype `#s6/#s7/#s8`. Reuse `/css/gp-tokens.css` + `js/nav-shell-bridge.js` + `js/auth-guard.js` like other doctor pages.

- [ ] **Step 5: Run tests → PASS**; `$NODE --check server.js` → OK.

- [ ] **Step 6: Commit**
```bash
git add pages/ahpra-rep-change.html server.js tests/ahpra-rep-change.test.js
git commit -m "feat(anom00): doctor email + in-app completion + submit to assigned officer"
```

---

## Task 8: Pinned-mailbox sender wiring (Component E)

**Files:**
- Modify: `server.js` (`resolveCaseSenderInfo` ~2587 + AHPRA-officer send sites)
- Test: `tests/ahpra-rep-change.test.js`

**Interfaces:**
- Consumes: `registration_cases.ahpra_auth_rep_email` (Task 1, set in Task 5).
- Produces: `resolveCaseSenderInfo(caseId, assignedVa, opts?)` gains `opts.purpose`. When `opts.purpose === 'ahpra_officer'` AND the case has `ahpra_auth_rep_email`, the "from" = that mailbox; otherwise unchanged.

- [ ] **Step 1: Write failing test** — extract the decision into a pure `pickSenderMailbox({ purpose, pinnedRepEmail, hubEmail, rsoEmail, hubOn })` and test:
```js
const { pickSenderMailbox } = server.__testUtils;
it('officer correspondence uses the pinned rep mailbox when set', () => {
  expect(pickSenderMailbox({ purpose:'ahpra_officer', pinnedRepEmail:'ben@mygplink.com.au', hubOn:true, hubEmail:'registration@mygplink.com.au' })).toBe('ben@mygplink.com.au');
});
it('non-officer purpose is unchanged (hub when on)', () => {
  expect(pickSenderMailbox({ purpose:'default', pinnedRepEmail:'ben@mygplink.com.au', hubOn:true, hubEmail:'registration@mygplink.com.au', rsoEmail:'hazel@mygplink.com.au' })).toBe('registration@mygplink.com.au');
});
it('officer correspondence falls back to normal when no pin', () => {
  expect(pickSenderMailbox({ purpose:'ahpra_officer', pinnedRepEmail:null, hubOn:true, hubEmail:'registration@mygplink.com.au', rsoEmail:'hazel@mygplink.com.au' })).toBe('registration@mygplink.com.au');
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `pickSenderMailbox`, call it inside `resolveCaseSenderInfo` (thread `opts.purpose`), and pass `purpose:'ahpra_officer'` at the AHPRA-officer send sites — the 6-card `_processAhpraEmail` officer replies, `_ensureAhpraConflictLetter`, and s80 officer emails (grep `ahpra_officer_email` + the officer send calls). Leave every other caller unchanged (default purpose).

- [ ] **Step 4: Run tests → PASS**; `$NODE --check server.js` → OK.

- [ ] **Step 5: Commit**
```bash
git add server.js tests/ahpra-rep-change.test.js
git commit -m "feat(anom00): route AHPRA-officer correspondence via the pinned rep mailbox"
```

---

## Task 9: Full-suite verification + push

- [ ] **Step 1: Full suite** — `$NODE node_modules/vitest/vitest.mjs run` → all green (≥ baseline + new tests).
- [ ] **Step 2: Syntax** — `$NODE --check server.js` → OK.
- [ ] **Step 3: Prototype parity** — open `docs/mockups/anom00-rep-change-prototype.html` and eyeball each built screen against it.
- [ ] **Step 4: Push the branch**
```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push -u origin worktree-ahpra-rep-change-anom00
```
- [ ] **Step 5:** Report what was verified locally vs. what needs live creds (real reassignment, real email to officer, Drive storage, pin flip) — do NOT claim live-verified what wasn't.

---

## Self-Review (checked against spec)

- **Spec §4 A–F** → Tasks 4 (A), 3 (B), 2 (C), 5+6+7 (D), 8 (E), 1 (F). ✔
- **Spec §5 data model** → Task 1. ✔
- **Spec §6 endpoints** → Tasks 4/5/7 (all listed endpoints present). ✔
- **Spec §7 edge cases** → officer fallback (Task 7), onboarding gate (Tasks 4/5), idempotent trigger (Task 6), missing signature (Task 2 throws), includeFiles (Task 2). ✔
- **Spec §3 open decision (submission mechanism)** → carried as an explicit `// OWNER-DECISION` marker in Task 7 Step 3; default documented. ✔
- **Type consistency:** `buildAnom00(data, sigs)`, `rsoCanBeAhpraRep`, `resolveAhpraSubmissionRecipient`, `shouldTriggerRepChange`, `pickSenderMailbox` used consistently across tasks. ✔
- **Note:** `ANOM00_FIELDS` coordinates are approximate and MUST be calibrated in Task 2 Step 4 (flat form, no AcroFields) — flagged, not a placeholder for logic.
