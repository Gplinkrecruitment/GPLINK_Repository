# Practice Client Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full medical-practice client pipeline: Facebook lead → prospective practice on CEO Practices tab → themed intake email → token-authed click-form → in-app e-sign of the Recruitment Services Agreement → practice promoted to active + pending job → admin approval (mandatory suburb header photo) → masked GP-facing listing (DPA gate, tailored ranking, blurred non-qualifying fillers) → practice acceptance/admin-apply → confetti congrats + "Secure My Interview" instant Zoom booking.

**Architecture:** Monolithic vanilla JS/HTML. All routes in `server.js` (raw `http`, `if (pathname === … && req.method === …)`), Supabase prod + `data/app-db.json` fallback (`supabaseDbRequest`/`dbState`/`saveDbState`). All NEW pure logic goes in `lib/practice-pipeline.js` + `lib/practice-agreement-pdf.js` so it is vitest-testable; server endpoints are thin glue. Reuse: `atsInsertPracticeRow`-family (server.js:24867), `atsInsertJobRow` (25042), `checkAndRecordWebhookEvent` (1189), `sendEmail` (24286) + `buildCareerEmailHtml` (24798), `supabaseStorageUploadObject` (6275), the 3-way interview scheduler (`lib/interview-scheduler.js`, endpoints at server.js:48153–48430), and the existing in-app masking machinery (`getCareerRoleGpLinkMeta` 14044).

**Tech Stack:** Node (no framework), pdf-lib, Resend, Supabase (PostgREST + Storage), vitest, vanilla HTML/JS pages.

## Global Constraints

- Never lie/fabricate; verify end-to-end (UI → API → DB → read-back); commit + push after every task.
- Local machine has NO system node/npm. Use `NODEBIN=/tmp/node-v20.18.1-darwin-arm64/bin`; run tests as `PATH="$NODEBIN:$PATH" npx vitest run <file>`; syntax-check with `"$NODEBIN/node" --check server.js` before every commit that touches server.js.
- Worktree: `/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/practice-client-pipeline`, branch `worktree-practice-client-pipeline`. `node_modules` is symlinked from the main checkout. Push via SSH deploy key (`~/.ssh/gplink_deploy` — remote already configured).
- Cache busters on changed script tags: `?v=20260705a`.
- Supabase DDL: write migration files; apply via `rpc/exec_sql` (param name `query`, schema-qualify) — **defer live application to merge time**; the code must tolerate missing columns where the repo already has that pattern (`isMissingColumnInsertError`, server.js:24939).
- Admin ATS endpoints gate on `requireAtsSession` (server.js:9221; super_admin + consultant). GP endpoints gate on `requireSession` (8587). Public endpoints: token/secret + rate-limit + honeypot per `/api/public/enquiry` (28008).
- Uploads are base64 data-URLs in JSON bodies (`parseDataUrlPayload`, server.js:6198) — no multipart.
- Emails: Resend `sendEmail({to,subject,html,text,from,replyTo,attachments,scheduledAt})`; attachments = `[{filename, content:<base64 string>, contentType}]`. Sender for practice emails: `from: { email: GP_OWNER_EMAIL /* hello@mygplink.com.au, server.js:164 */, name: 'GP Link' }`.
- The signed agreement PDF asset: `assets/legal/gp-link-practice-agreement-2026.pdf` (already committed; 11 A4 pages, loads cleanly in pdf-lib with `{ignoreEncryption:true}`).
- Google Maps embeds: masked = `https://www.google.com/maps?q=<suburb>+<state>&z=12&output=embed` (never street address); revealed = full address `z=15`.
- NEVER include `practice_name` or exact address in any masked serialization (public site, non-revealed in-app).
- `meta.env`: new env vars `FB_LEAD_WEBHOOK_SECRET`, `FB_LEAD_VERIFY_TOKEN` — read with `process.env.X || ''`; endpoints 503 politely when unset.

## Locked decisions (deviations & resolutions — approved in spec §10, refined by research)

1. `career_roles.approval_status` DDL default is **'approved'** (NOT 'pending' as the spec sketch says) so the ~49 live Zoho/ATS jobs stay visible; the practice-intake job-creation path sets `'pending'` + `is_active:false` explicitly. Visibility is doubly safe because every existing GP/public query already filters `is_active=eq.true`.
2. `practices.stage` DDL default is **'active'** (existing rows are live clients); the Facebook webhook sets `'prospective'` explicitly.
3. Signature stamping = **appended execution page** (pdf-lib `addPage` + embedded signature PNG + name/date/IP/token), not coordinate-guessing inside the 11-page original.
4. "Practice accepts" trigger = explicit admin action **POST /api/ats/application/accept** (new button in the CEO candidate drawer), because no machine-readable practice-acceptance signal exists today. Admin-apply (`POST /api/ats/application`) triggers the same congrats flow immediately with `origin='admin_applied'`.
5. Blurred fillers = jobs failing the DPA gate are shown as **server-side redacted stubs** (generic title, state-level location, no apply) rendered blurred — per spec §10.5 "shown blurred, not hidden, to fill the page". No full job data ever reaches the client for non-qualifying roles.
6. Reveal rule (single helper): `origin==='admin_applied'` OR `revealed===true` OR (backward-compat) the application's offer is already `status='accepted'`.
7. Header images upload to the existing `CAREER_HERO_IMAGE_BUCKET` (`career-hero-images`, server.js:224) via public URLs; local dev falls back to storing the data-URL on the row.
8. `vercel.json` `includeFiles` must gain `"assets/**"` (existing gotcha: files not in includeFiles 404 in prod).

## File Structure (new files)

- `supabase/migrations/20260705100000_practice_client_pipeline.sql` — all DDL.
- `lib/practice-pipeline.js` — ALL new pure logic: token gen, FB payload normalization, intake validation, masked title/label builders, reveal rule, DPA gate + ranking + redacted stub, email copy builders.
- `lib/practice-agreement-pdf.js` — pdf-lib execution-page stamping.
- `pages/practice-intake.html` — public token-authed click-form + agreement e-sign (signature pad).
- `pages/secure-interview.html` — GP slot picker + instant booking confirmation.
- `tests/practice-pipeline.test.js`, `tests/practice-agreement-pdf.test.js` — vitest.
- Modified: `server.js`, `js/ceo-ats-practices.js`, `js/ceo-ats-jobs.js`, `js/ceo-ats-candidates.js`, `pages/ceo-dashboard.html` (script cache-busters only), `pages/career.html`, `pages/job.html`, `pages/site-jobs.html`, `pages/site-job.html`, `pages/offer-review.html`, `pages/onboarding.html`, `js/onboarding.js`, `vercel.json`.

---

### Task 1: Migration + vercel includeFiles

**Files:**
- Create: `supabase/migrations/20260705100000_practice_client_pipeline.sql`
- Modify: `vercel.json` (includeFiles array)

**Interfaces:**
- Produces: columns used by every later task — `practices.{stage,website,dpa,billing_style,nearest_city,suburb,state? (NO — practices already has location_state), address,agreement_status,agreement_signed_at,agreement_signed_by,agreement_signed_pdf_key,intro_text,intro_video_url,intake_token,metadata}`; `career_roles.{masked_title,header_image_url,nearest_city,suburb,approval_status}`; `gp_applications.{revealed,origin}`; `user_profiles.australia_trained`.

- [ ] **Step 1: Write the migration file** (exact content):

```sql
-- Practice client pipeline (2026-07-05).
-- Apply via rpc/exec_sql with the service key (param name: query). exec_sql returns void; verify via PostgREST reads.

-- practices: lifecycle + intake + agreement
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'active';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS website text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS dpa boolean;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS billing_style text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS nearest_city text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS suburb text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS agreement_status text NOT NULL DEFAULT 'unsigned';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS agreement_signed_at timestamptz;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS agreement_signed_by text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS agreement_signed_pdf_key text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS intro_text text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS intro_video_url text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS intake_token text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.practices DROP CONSTRAINT IF EXISTS practices_stage_check;
ALTER TABLE public.practices ADD CONSTRAINT practices_stage_check CHECK (stage IN ('prospective','active','declined','archived'));
ALTER TABLE public.practices DROP CONSTRAINT IF EXISTS practices_agreement_status_check;
ALTER TABLE public.practices ADD CONSTRAINT practices_agreement_status_check CHECK (agreement_status IN ('unsigned','sent','signed'));
ALTER TABLE public.practices DROP CONSTRAINT IF EXISTS practices_source_check;
ALTER TABLE public.practices ADD CONSTRAINT practices_source_check CHECK (source IN ('zoho_sync','internal_ats','manual','backfill','facebook_lead'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_practices_intake_token ON public.practices(intake_token) WHERE intake_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_practices_stage ON public.practices(stage, name);

-- career_roles: masking + display + approval
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS masked_title text NOT NULL DEFAULT '';
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS header_image_url text NOT NULL DEFAULT '';
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS nearest_city text NOT NULL DEFAULT '';
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS suburb text NOT NULL DEFAULT '';
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE public.career_roles DROP CONSTRAINT IF EXISTS career_roles_approval_status_check;
ALTER TABLE public.career_roles ADD CONSTRAINT career_roles_approval_status_check CHECK (approval_status IN ('pending','approved','rejected'));
CREATE INDEX IF NOT EXISTS idx_career_roles_approval ON public.career_roles(approval_status) WHERE approval_status <> 'approved';

-- gp_applications: reveal + origin
ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS revealed boolean NOT NULL DEFAULT false;
ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'gp_applied';
ALTER TABLE public.gp_applications DROP CONSTRAINT IF EXISTS gp_applications_origin_check;
ALTER TABLE public.gp_applications ADD CONSTRAINT gp_applications_origin_check CHECK (origin IN ('gp_applied','admin_applied'));

-- user_profiles: Australia-trained flag (onboarding mirror)
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS australia_trained boolean;
```

- [ ] **Step 2: Add `"assets/**"` to `vercel.json` includeFiles** (currently `["pages/**","js/**","css/**","media/**","documents/**","sw.js","data/.gitkeep"]`).
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(pipeline): practice lifecycle + masking + reveal DDL; ship agreement asset via vercel includeFiles" && git push -u origin worktree-practice-client-pipeline`
  (This commit also picks up `assets/legal/gp-link-practice-agreement-2026.pdf` and this plan file, already in the worktree.)

**Server-code tolerance note for later tasks:** every new-column write on `practices`/`gp_applications` must use the existing missing-column retry pattern (`isMissingColumnInsertError(result, '<col>')`, server.js:24939-24948) OR write columns individually tolerant — copy the `_gpApplicationsPracticeIdMissing` approach with new flags `_practicesPipelineColumnsMissing` and `_gpApplicationsRevealMissing`.

---

### Task 2: `lib/practice-pipeline.js` pure helpers + tests

**Files:**
- Create: `lib/practice-pipeline.js`
- Test: `tests/practice-pipeline.test.js`

**Interfaces (Produces — later tasks import exactly these):**
```js
module.exports = {
  generateIntakeToken,            // () => 32-char base64url string
  normalizeFacebookLeadPayload,   // (body) => { leadId, practice_name, contact_name, contact_email, contact_phone, location, website, dpa } | null
  validatePracticeIntakePayload,  // (body) => { ok:true, value } | { ok:false, error }
  buildMaskedTitle,               // ({nearestCity, suburb, billingStyle, dpa, visaSponsorship, earningsText}) => string
  buildMaskedDisplayLabel,        // ({billingStyle, dpa, nearestCity}) => 'Mixed Billing · Non-DPA · near Melbourne'
  canRevealPracticeIdentityCore,  // ({application, offer}) => boolean
  gpQualifiesForRole,             // (roleRow, {australiaTrained}) => {qualifies:boolean, reason?:'dpa_restricted'}
  rankRolesForGp,                 // (roleRows, {preferredCity}) => sorted copy (city match, then state, then recency)
  buildRedactedRoleStub,          // (clientRole) => blurred stub object {id, title:'GP Opportunity', practiceName:'Confidential practice', location:<state or 'Australia'>, qualifies:false, blurred:true, qualifyReason}
  buildIntakeEmailCopy,           // ({practiceName, intakeUrl}) => {subject, title, body, ctaText, ctaUrl, footer}
  buildCongratsEmailCopy,         // ({gpName, practiceName, secureUrl}) => {subject, title, body, ctaText, ctaUrl, footer}
  INTAKE_FIELDS,                  // array of {key, label, type, required, options?} — single source for form + validation
};
```

Implementation notes (write real code, no placeholders):
- `generateIntakeToken`: `crypto.randomBytes(24).toString('base64url')`.
- `normalizeFacebookLeadPayload`: accept (a) native FB Lead Ads: `body.entry[0].changes[0].value` with `leadgen_id` and `field_data:[{name, values:[v]}]` (map field names case-insensitively: `practice_name|company_name|full_name→practice_name/contact_name`, `email`, `phone_number|phone`, `city|location`, `website`, `dpa`), and (b) Zapier/Make flat JSON `{practice_name, location, contact_name, contact_email, contact_phone, website, dpa}` with `lead_id|id` as leadId. If neither `practice_name` nor `contact_email` resolves → `null`. When no explicit lead id, `leadId = 'sha1:' + crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')`.
- `validatePracticeIntakePayload` — `INTAKE_FIELDS` (mirror the Alecto reference layout):
  `billing_style` (required, one of mixed/bulk/private), `dpa` (required boolean), `mmm` (string ''–'MM7'), `visa_sponsorship` (boolean), `ownership` (string), `years_operating` (string), `nursing_on_site` (boolean), `gp_count` (string), `percentage_split` (required string e.g. '70%'), `incentives` (string ≤2000), `earnings_text` (string ≤300), `suburb` (required ≤120), `nearest_city` (required ≤120), `state` (required, AU state code), `address` (required ≤300 — never shown to GPs until reveal), `general_location` (string), `role_title` (string ≤200), `role_summary` (string ≤4000), `intro_text` (≤4000), `intro_video_url` (must start `https://` when present). Trim everything; booleans accept true/'true'/'yes'.
- `buildMaskedTitle`: `'GP Job near Melbourne | Mixed Billing | DPA Approved | Earnings ~$8k/wk'` — parts: `'GP Job near ' + (nearestCity||suburb||'you')`; billing label; `dpa ? 'DPA Approved' : (visaSponsorship ? 'PR Visa Option' : '')`; `earningsText ? 'Earnings ' + earningsText : ''`; join non-empty with `' | '`.
- `buildMaskedDisplayLabel`: `[billingLabel, dpa===true?'DPA':'Non-DPA', nearestCity?'near '+nearestCity:''].filter(Boolean).join(' · ')`.
- `canRevealPracticeIdentityCore({application, offer})`: `false` if no application; `true` if `application.origin==='admin_applied'` or `application.revealed===true` or (`offer && offer.status==='accepted'`).
- `gpQualifiesForRole(role, gp)`: `role.dpa===true → qualifies`; else `gp.australiaTrained===true → qualifies`; else `{qualifies:false, reason:'dpa_restricted'}`.
- `rankRolesForGp(rows, {preferredCity})`: score 0 = case-insensitive match of preferredCity against `nearest_city|location_city|location_label`; 1 = same `location_state` as any row matching preferredCity (skip if no preferredCity → all score 1); 2 = rest; stable-sort by (score, `published_at||created_at` desc). Return new array.
- `buildRedactedRoleStub(role)`: from an already-serialized client role keep ONLY `{ id, title:'GP Opportunity', practiceName:'Confidential practice', location:(role.state||'Australia'), billing:'', summary:'You don\'t currently qualify for this role.', qualifies:false, blurred:true, qualifyReason:role.qualifyReason||'dpa_restricted' }`.
- `buildIntakeEmailCopy`: subject `'Your GP is waiting — complete your job details'`; body copy MUST include: intro to GP Link, the **"we can source you a GP within 30 days"** promise, the GP Link difference (specialist matching + full overseas registration support), CTA `'Complete your job details'` → intakeUrl; footer `'You are receiving this because you enquired about GP recruitment with GP Link.'`.
- `buildCongratsEmailCopy`: subject `'Congratulations — a practice wants to meet you 🎉'`; body: practiceName wants to move forward; CTA `'Secure My Interview'` → secureUrl.

- [ ] **Step 1: Write failing tests** `tests/practice-pipeline.test.js` covering: token shape/uniqueness; FB native + flat payload mapping + null on garbage + sha1 fallback id; intake validation (happy path, missing suburb, bad billing_style, boolean coercion); masked title exact string for the Melbourne example; display label `'Mixed Billing · Non-DPA · near Melbourne'`; reveal core (admin_applied true / revealed true / accepted-offer true / plain applied false / no app false); DPA gate (dpa job always visible; non-DPA hidden unless australiaTrained); ranking (city match first, state second, other last); redacted stub leaks no practiceName/suburb/address fields.
- [ ] **Step 2: Run** `PATH="$NODEBIN:$PATH" npx vitest run tests/practice-pipeline.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement `lib/practice-pipeline.js`** per the interface above.
- [ ] **Step 4: Run again** → all PASS.
- [ ] **Step 5: Commit + push** `feat(pipeline): pure helpers — intake validation, masking, reveal rule, DPA gate, ranking`

---

### Task 3: `lib/practice-agreement-pdf.js` (execution-page stamping) + tests

**Files:**
- Create: `lib/practice-agreement-pdf.js`
- Test: `tests/practice-agreement-pdf.test.js`

**Interfaces:**
- Produces: `async stampAgreementExecutionPage({ agreementBytes, signaturePngDataUrl, signedName, practiceName, dateLabel, ipAddress, token }) => Buffer` — loads with `PDFDocument.load(agreementBytes, {ignoreEncryption:true})`, `doc.addPage([595.5, 842.25])`, draws heading `'Execution Page — Recruitment Services Agreement (2026)'`, lines for practice name, signer name + "authorised to sign on behalf of the practice", date, IP, verification token (last 8 chars), then embeds the signature PNG (`doc.embedPng`) at width ≤ 260 preserving aspect, label `'Signature:'`. Uses `StandardFonts.Helvetica` / `HelveticaBold`. Returns `Buffer.from(await doc.save())`.
- Accepts `signaturePngDataUrl` = `data:image/png;base64,...`; throw `new Error('invalid_signature_image')` if it doesn't match that prefix.

- [ ] **Step 1: Write failing test** — load `assets/legal/gp-link-practice-agreement-2026.pdf` from disk, generate a tiny valid PNG data URL in the test (1×1 px: use pdf-lib-independent hardcoded base64 `'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='`), call the stamper, then reload output with pdf-lib and assert `getPageCount() === 12` and the buffer is larger than input; assert it throws on `data:image/jpeg;...`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit + push** `feat(pipeline): pdf-lib execution-page stamper for the practice agreement`

---

### Task 4: Facebook lead webhook → prospective practice + intake email + resend action

**Files:**
- Modify: `server.js` — (a) route dispatch next to the DoubleTick early-route (`server.js:25796`), (b) handler + helpers near the DoubleTick handler block (~8130), (c) admin resend endpoint next to `PATCH /api/ats/practice` (~48517).

**Interfaces:**
- Consumes: `practicePipeline = require('./lib/practice-pipeline')` (add near other lib requires ~line 151), `checkAndRecordWebhookEvent` (1189), `atsInsertPracticeRow`/`atsGetPracticeRow`/`atsUpdatePracticeRow` (24867+), `sendEmail` (24286), `buildCareerEmailHtml` (24798), `GP_OWNER_EMAIL` (164), `APP_BASE_URL`, `checkRateLimitWindow` (used by DoubleTick handler), `getClientIp` (8415), `readJsonBody` (7893), `sendJson`.
- Produces: `POST/GET /api/webhooks/facebook-lead`; `POST /api/ats/practice/resend-intake?id=`; server fn `sendPracticeIntakeEmail(practiceRow) => Promise<{ok}>`.

Route dispatch (place immediately after the DoubleTick line at 25796):
```js
  if (pathname === '/api/webhooks/facebook-lead') return handleFacebookLeadWebhook(req, res);
```

Handler behavior (write it in full):
- `GET`: FB verification handshake — if `hub.mode==='subscribe' && hub.verify_token === (process.env.FB_LEAD_VERIFY_TOKEN||'')` and token non-empty → 200 plain-text `hub.challenge`; else 403.
- `POST`: 503 `{ok:false}` if `!process.env.FB_LEAD_WEBHOOK_SECRET`; timing-safe compare `?secret=` query param (copy the DoubleTick `crypto.timingSafeEqual` block at 8130 verbatim, including length guard); rate-limit `checkRateLimitWindow('fb_lead_webhook:'+ip, 30, 60*60*1000)` → 429; `readJsonBody`; `practicePipeline.normalizeFacebookLeadPayload(body)` → 400 `{ok:false, error:'unrecognized_payload'}` on null; dedup `await checkAndRecordWebhookEvent('facebook_lead', lead.leadId, 'lead', {event:'lead', created_at:new Date().toISOString()})` → if true respond 200 `{ok:true, action:'duplicate_ignored'}`; insert practice:
```js
    var pracRow = {
      name: lead.practice_name || (lead.contact_name ? lead.contact_name + "'s practice" : 'New practice lead'),
      location_city: lead.location || '', location_state: '', location_country: 'Australia',
      practice_type: '', contact_name: lead.contact_name || '', contact_email: lead.contact_email || '',
      contact_phone: lead.contact_phone || '', ahpra_number: '',
      source: 'facebook_lead', is_active: true, created_by: 'facebook_lead_webhook',
      stage: 'prospective', website: lead.website || '',
      dpa: typeof lead.dpa === 'boolean' ? lead.dpa : null,
      intake_token: practicePipeline.generateIntakeToken(),
      agreement_status: 'unsigned',
      metadata: { fb_lead: lead, fb_raw: body }
    };
```
  Insert via `atsInsertPracticeRow(pracRow)`; if insert fails AND Supabase is configured, retry once with only the pre-existing columns (`name…created_by`) plus log — the missing-column tolerance for un-applied DDL (keep `intake_token` in `metadata.intake_token` in that fallback so the flow still works; readers check both `row.intake_token || (row.metadata && row.metadata.intake_token)`). Then `await sendPracticeIntakeEmail(created)` (best-effort, `.catch(()=>{})` + log) and 200 `{ok:true, practice_id: created.id}`.
- `sendPracticeIntakeEmail(practice)`: token = `practice.intake_token || (practice.metadata && practice.metadata.intake_token)`; if no token, generate + patch row first; `intakeUrl = APP_BASE_URL + '/pages/practice-intake?token=' + encodeURIComponent(token)`; copy from `practicePipeline.buildIntakeEmailCopy({practiceName: practice.name, intakeUrl})`; `sendEmail({ to: practice.contact_email, subject: copy.subject, html: buildCareerEmailHtml(copy), from: { email: GP_OWNER_EMAIL, name: 'GP Link' } })`; on ok, patch `metadata.intake_email_last_sent_at` (merge metadata: read row, spread, PATCH).
- `POST /api/ats/practice/resend-intake` (place after the PATCH /api/ats/practice block ~48517): `requireAtsSession`; `?id=` must be a **row id** (reject `name:` ids with 400 `{ok:false, message:'This practice has no stored record yet.'}` via `atsParsePracticeId`); load row (404); call `sendPracticeIntakeEmail`; 200 `{ok:true}`.

- [ ] **Step 1:** Add the `practicePipeline` require + routes + handler + resend endpoint.
- [ ] **Step 2:** `"$NODEBIN/node" --check server.js` → OK.
- [ ] **Step 3: Manual smoke (local JSON db mode)** — start `PATH="$NODEBIN:$PATH" FB_LEAD_WEBHOOK_SECRET=testsecret node server.js` in background, then:
  `curl -s 'http://localhost:3000/api/webhooks/facebook-lead?hub.mode=subscribe&hub.verify_token=&hub.challenge=x'` → 403 (no verify token set);
  `curl -s -X POST 'http://localhost:3000/api/webhooks/facebook-lead?secret=testsecret' -H 'Content-Type: application/json' -d '{"lead_id":"L1","practice_name":"Sunshine Family Practice","location":"Sunshine VIC","contact_name":"Dr A","contact_email":"a@example.com","contact_phone":"+61 400 000 000","website":"https://sunshine.example","dpa":false}'` → `{ok:true, practice_id:…}`; repeat same curl → duplicate_ignored **only when Supabase configured — in local mode `checkAndRecordWebhookEvent` short-circuits, note actual observed behavior honestly**; wrong secret → 401. Check `data/app-db.json` has the practice with `stage:'prospective'`. Kill server.
- [ ] **Step 4: Commit + push** `feat(pipeline): Facebook lead webhook → prospective practice + themed intake email + resend action`

---

### Task 5: Intake API — GET/POST `/api/practice-intake`

**Files:**
- Modify: `server.js` — new public routes next to `/api/public/enquiry` (~28008).

**Interfaces:**
- Consumes: `validatePracticeIntakePayload`, `atsUpdatePracticeRow`, `supabaseDbRequest`/`dbState.atsPractices`, `checkRateLimitWindow`, `getClientIp`.
- Produces:
  - `GET /api/practice-intake?token=` → `{ ok:true, practice: { name, contact_name, agreement_status, stage, intake: <saved intake object or null>, submitted: !!intake } }` (404 `{ok:false}` on unknown token; NEVER return internal ids or other rows' data).
  - `POST /api/practice-intake` body `{ token, ...INTAKE_FIELDS }` → validates, saves, `{ok:true}`.
  - Server helper `findPracticeByIntakeToken(token)` — Supabase: `supabaseDbRequest('practices', 'select=*&intake_token=eq.' + encodeURIComponent(token) + '&limit=1')`, falling back to scanning `metadata->>intake_token`? PostgREST filter for metadata: also try `metadata->>intake_token=eq.` when the column query returns empty AND the first query errored (missing column). Local: scan `dbState.atsPractices` for `p.intake_token || (p.metadata && p.metadata.intake_token)`.

Behavior details:
- Both routes rate-limit: `checkRateLimitWindow('practice_intake:'+ip, 30, 60*60*1000)` → 429.
- Token must be ≥ 16 chars else 404 (don't leak validity).
- POST honeypot: hidden `website_hp` field — if non-empty, respond `{ok:true}` and store nothing (mirror `/api/public/enquiry` honeypot at 17542).
- POST saves: intake value object → practice columns where they exist (`billing_style, dpa, nearest_city, suburb, address, website, intro_text, intro_video_url`, `location_state` from `state`, `location_city` from `nearest_city`) AND full `value` under `metadata.intake` (merge metadata). If practice already `agreement_status==='signed'`, still allow re-save of intake but do NOT allow re-sign later (Task 6 guards).
- Signed practices with a job already created: `POST` responds `{ok:true, already_signed:true}`.

- [ ] **Step 1:** Implement both routes + `findPracticeByIntakeToken`.
- [ ] **Step 2:** `"$NODEBIN/node" --check server.js`.
- [ ] **Step 3: Manual smoke (local mode):** create a lead via the Task-4 curl, grab token from `data/app-db.json`, `curl GET /api/practice-intake?token=…` → practice name; `curl POST` with a full valid intake payload → ok; GET again → `submitted:true` and saved fields echoed. Bad token → 404. Record real outputs.
- [ ] **Step 4: Commit + push** `feat(pipeline): token-authed practice intake API (load + save)`

---

### Task 6: Sign endpoint — stamp, store, promote, create pending job, emails

**Files:**
- Modify: `server.js` — `POST /api/practice-intake/sign` next to the Task-5 routes; helper `createPendingJobFromIntake(practiceRow, intake)` near the ATS job helpers (~25042).

**Interfaces:**
- Consumes: `stampAgreementExecutionPage` (require `./lib/practice-agreement-pdf` near other requires), `fs.readFileSync(path.join(process.cwd(),'assets/legal/gp-link-practice-agreement-2026.pdf'))` (cache in a module-level `let _agreementPdfBytes`), `supabaseStorageUploadObject` (6275) + `SUPABASE_DOCUMENT_BUCKET` (73), `supabaseStorageCreateSignedUrl` (6320), `atsInsertJobRow` (25042), `buildMaskedTitle`, `sendEmail`, `buildCareerEmailHtml`, `notifyOfficerOrTeam`? — team notify = `sendEmail` to `GP_OWNER_EMAIL`.
- Produces: `POST /api/practice-intake/sign` body `{ token, signature_data_url, signed_name, authorised:true }` → `{ ok:true, practice_stage:'active', job_id, signed_pdf_url? }`.

Behavior (in order — write it exactly):
1. Rate-limit + token lookup (same helpers as Task 5). 404 unknown.
2. Reject if `agreement_status === 'signed'` → 409 `{ok:false, error:'already_signed'}`.
3. Reject if no saved `metadata.intake` → 409 `{ok:false, error:'intake_incomplete'}` (the click-form must be submitted first).
4. Validate `authorised === true`, `signed_name` non-empty ≤ 200, `signature_data_url` starts `data:image/png;base64,` and ≤ 2 MB → 400 otherwise.
5. `stampAgreementExecutionPage({...})` with `dateLabel = new Date().toLocaleDateString('en-AU', {day:'2-digit',month:'long',year:'numeric',timeZone:'Australia/Sydney'})`, `ipAddress = getClientIp(req)`, token.
6. Store: `signedKey = 'practices/' + practice.id + '/agreement-signed.pdf'`; Supabase: `supabaseStorageUploadObject(SUPABASE_DOCUMENT_BUCKET, signedKey, 'data:application/pdf;base64,' + stamped.toString('base64'), 'application/pdf')`; local mode: write to `data/practice-agreements/<id>.pdf` via `fs.mkdirSync(recursive)+writeFileSync` and set `signedKey = 'local:data/practice-agreements/<id>.pdf'`.
7. Patch practice: `{ stage:'active', agreement_status:'signed', agreement_signed_at: new Date().toISOString(), agreement_signed_by: signed_name, agreement_signed_pdf_key: signedKey }` via `atsUpdatePracticeRow` (with metadata-merge fallback when columns missing).
8. `createPendingJobFromIntake(practice, intake)` — builds and inserts the `career_roles` row:
```js
    var intakeJobRow = {
      provider: 'internal_ats', provider_role_id: 'ats_' + atsLocalId(''),
      title: intake.role_title || practicePipeline.buildMaskedTitle({ nearestCity: intake.nearest_city, suburb: intake.suburb, billingStyle: intake.billing_style, dpa: intake.dpa === true, visaSponsorship: intake.visa_sponsorship === true, earningsText: intake.earnings_text }),
      masked_title: practicePipeline.buildMaskedTitle({ /* same args */ }),
      practice_name: practice.name, practice_id: practice.id,
      location_city: intake.nearest_city || '', location_state: intake.state || '', location_country: 'Australia',
      suburb: intake.suburb || '', nearest_city: intake.nearest_city || '',
      billing_model: intake.billing_style || '', dpa: intake.dpa === true, mmm: intake.mmm || '',
      earnings_text: intake.earnings_text || '',
      summary: [intake.role_summary, intake.incentives ? 'Additional incentives: ' + intake.incentives : '', intake.percentage_split ? 'Percentage split: ' + intake.percentage_split : ''].filter(Boolean).join('\n\n'),
      employment_type: '', practice_type: intake.ownership || '',
      mixed_billing: intake.billing_style === 'mixed', private_billing: intake.billing_style === 'private',
      visa_pathway_aligned: intake.visa_sponsorship === true,
      is_active: false, job_status: 'open', approval_status: 'pending',
      ats_created: true, posted_by: 'practice_intake',
      source_payload: { intake: intake, practice_intro: { text: practice.intro_text || intake.intro_text || '', video_url: practice.intro_video_url || intake.intro_video_url || '' } },
      synced_at: atsNowIso()
    };
```
   With missing-column tolerance: on insert error retry without `{masked_title, header_image_url, nearest_city, suburb, approval_status}` but KEEP `is_active:false` (that alone hides it) and stash the dropped fields under `source_payload.pipeline`.
9. Emails (best-effort, each `.catch`): (a) practice confirmation via Resend with the **stamped PDF attached** — `sendEmail({ to: practice.contact_email, from:{email:GP_OWNER_EMAIL,name:'GP Link'}, subject:'Your signed GP Link agreement — welcome aboard', html: buildCareerEmailHtml({title:'Agreement signed ✔', body:'…what happens next: our team reviews your job listing and it goes live to matched GPs. Your GP search has started — remember our 30-day sourcing promise.', footer:'A copy of your countersigned agreement is attached.'}), attachments:[{ filename:'GP-Link-Recruitment-Services-Agreement-signed.pdf', content: stamped.toString('base64'), contentType:'application/pdf' }] })`; (b) team notify to `GP_OWNER_EMAIL`: subject `'New signed practice: <name> — job pending approval'` with a link `APP_BASE_URL + '/pages/ceo-dashboard#practice=' + practice.id`.
10. Respond `{ ok:true, practice_stage:'active', job_id: createdJob && createdJob.id }`.

- [ ] **Step 1:** Implement endpoint + helper. **Step 2:** `node --check`. 
- [ ] **Step 3: Manual smoke (local mode):** full curl sequence — lead → intake POST → sign POST (use the 1×1 PNG data URL from Task 3's test) → assert response `{ok:true, practice_stage:'active', job_id}`; verify in `data/app-db.json`: practice `stage:'active'`, `agreement_status:'signed'`; job row `approval_status:'pending'`, `is_active:false`, `masked_title` set; `data/practice-agreements/<id>.pdf` exists and opens (12 pages — check with the Task-3 pdf-lib snippet). Re-sign → 409. Record real outputs.
- [ ] **Step 4: Commit + push** `feat(pipeline): in-app agreement signing → signed PDF stored + practice promoted + pending job created`

---

### Task 7: `pages/practice-intake.html` — click-form + signature pad UI

**Files:**
- Create: `pages/practice-intake.html` (self-contained page: inline `<style>` + `<script>`, no auth-guard include — it is public/token-authed; do NOT include `js/auth-guard.js`).

**Interfaces:**
- Consumes: `GET /api/practice-intake?token=`, `POST /api/practice-intake`, `POST /api/practice-intake/sign`, static `/assets/legal/gp-link-practice-agreement-2026.pdf`.

Requirements (all must ship):
- Reads `token` from `location.search`; on load GETs the API; unknown token → friendly "This link has expired — contact hello@mygplink.com.au" state.
- **Step A (form):** fields exactly = `INTAKE_FIELDS` (billing style select Mixed/Bulk/Private; DPA Yes/No; MMM select MM1–MM7/unsure; visa sponsorship Y/N; ownership; years operating; nursing on site Y/N; GPs at practice; percentage split; additional incentives; earnings guide; suburb; nearest city; state select (AU 8); street address; general location; role title; role summary). Include hidden honeypot input `name="website_hp"` styled `position:absolute;left:-9999px`.
- **Optional intro block** with the exact nudge copy: **“Practices that add a personal introduction see a 150% higher match rate.”** — textarea `intro_text` + input `intro_video_url` ("link to a short video — Loom, YouTube unlisted, etc.").
- Pre-fills saved values when `practice.intake` present (re-entry).
- Submit → POST → on ok advance to **Step B (agreement)** in the same page (no reload): embedded PDF `<iframe src="/assets/legal/gp-link-practice-agreement-2026.pdf" style="width:100%;height:480px;border:1px solid #e2e8f0;border-radius:12px">` + fallback download link; signature `<canvas>` pad (~300×140, mouse + touch via pointer events, Clear button) **plus** a "type your signature instead" text input that renders italic serif text onto the canvas via a "Use typed signature" button; printed-name input; date auto-shown (today, AEST); required checkbox **“I am authorised to sign on behalf of the practice”**.
- Sign button → `canvas.toDataURL('image/png')` → POST `/api/practice-intake/sign` → success state: green tick, "Agreement signed — your job listing is with our team for approval. Watch your inbox." If `already_signed` → show the success state too.
- GP Link look: reuse the site's blue `#2563eb`, wordmark header text "GP Link", system font stack, mobile-first (max-width 640 card). Empty canvas guard: block sign when nothing drawn/typed (track a `hasInk` flag).

- [ ] **Step 1:** Build the page. **Step 2: Manual verify (local mode):** with the Task-6 lead, open `http://localhost:3000/pages/practice-intake?token=…` via curl to confirm 200 HTML served (full browser check happens in Task 13). **Step 3: Commit + push** `feat(pipeline): practice intake click-form + agreement e-sign page`

---

### Task 8: CEO Practices tab — Potential Clients vs Mainstream + intake surfacing

**Files:**
- Modify: `server.js` `GET /api/ats/practices` (48457) + `GET /api/ats/practice` (48491) + `PATCH /api/ats/practice` (48517); `js/ceo-ats-practices.js`; `pages/ceo-dashboard.html` (cache-buster line 6532 → `?v=20260705a`).

**Interfaces:**
- Consumes: existing `atsListPracticesDerived` (24978) — extend the merged rows to carry `stage`, `agreement_status`, `contact_*`, `website`, `dpa`, `suburb`, `nearest_city`, `intake_token`-presence, `metadata.intake` presence.
- Produces: `GET /api/ats/practices` response gains per-card `stage` (`'prospective'|'active'|…`; derived/name-only practices report `'active'`), `agreement_status`, and top-level `counts: { prospective, active }`. `PATCH /api/ats/practice` accepts `stage` (validated against the 4 values). `GET /api/ats/practice` returns the new fields + `intake` object + `agreement_signed_pdf_url` (signed URL via `supabaseStorageCreateSignedUrl(SUPABASE_DOCUMENT_BUCKET, key, 'agreement.pdf')` when key non-`local:`).

UI changes in `js/ceo-ats-practices.js`:
- `renderDirectory`: two sections — **“Potential Clients”** (stage `prospective`, count chip) listed FIRST, then **“Mainstream Practices”** (stage `active`); `declined`/`archived` collapsed under a "Archived & declined" details element.
- Prospective card extras: contact name/email/phone, source chip `Facebook lead`, agreement chip (`unsigned`/`sent`/`signed`), and two buttons: **“📞 Call”** (`<a href="tel:…">` styled as button; disabled-looking when no phone) and **“Resend intake email”** (`data-ats="resend-intake" data-id`) → `ATS.api('/api/ats/practice/resend-intake?id='+id, {method:'POST'})` → `ATS.toast('Intake email sent')` / error toast.
- Detail view (`renderDetail`): add fields Stage (select bound to PATCH `{stage}`), Agreement status (+ "View signed PDF" link when `agreement_signed_pdf_url`), Website, DPA, Suburb/Nearest city, and an "Intake answers" card listing `metadata.intake` key/values when present; intro text/video shown when set.
- Master tab count `#masterPracCount` already comes from list length — keep.

- [ ] **Step 1:** Server changes (list/patch/detail). **Step 2:** `node --check`. **Step 3:** UI changes + cache-buster.
- [ ] **Step 4: Manual smoke:** curl `GET /api/ats/practices` (local admin session — in local mode use the dev admin cookie flow; if not feasible via curl, verify by direct function-shape inspection and defer click-through to Task 13; SAY which you did).
- [ ] **Step 5: Commit + push** `feat(pipeline): CEO practices tab splits Potential Clients vs Mainstream + intake detail + resend/call actions`

---

### Task 9: Job approval — mandatory suburb header photo + approve/reject

**Files:**
- Modify: `server.js` — `POST /api/ats/job/header-image`, `GET /api/ats/suburb-images`, `POST /api/ats/job/approve` (all near the ATS job endpoints ~47856); extend `atsJobCard` (25745) with `approval_status`, `header_image_url`, `suburb`, `masked_title`.
- Modify: `js/ceo-ats-jobs.js` — pending-approval UI; `pages/ceo-dashboard.html` cache-buster (jobs js line 6531 → `?v=20260705a`).

**Interfaces:**
- `POST /api/ats/job/header-image?id=` body `{ file_data:<dataURL>, file_name }` — `requireAtsSession`; validate mime `image/(png|jpe?g|webp)` + ≤ 8 MB; Supabase: key `'suburbs/' + <slug of job.suburb||location_city> + '/' + Date.now() + '.' + ext` in `CAREER_HERO_IMAGE_BUCKET` (224) via `supabaseStorageUploadObject`, URL = `buildSupabaseStoragePublicUrl(CAREER_HERO_IMAGE_BUCKET, key)` (6350); local mode: URL = the data-URL itself. PATCH job `{header_image_url:url}` → `{ok:true, url}`.
- `GET /api/ats/suburb-images` — `requireAtsSession`; from `atsListJobRows()` (note: lists only `is_active=true` — ALSO query inactive: use `supabaseDbRequest('career_roles','select=suburb,location_city,header_image_url&header_image_url=neq.&limit=500')` with local fallback scan) build unique `[{suburb, url}]` → `{ok:true, images}`.
- `POST /api/ats/job/approve?id=` body `{ action:'approve'|'reject' }` — `requireAtsSession`; job must be `approval_status==='pending'` (409 otherwise); **approve requires `header_image_url` non-empty → else 400 `{ok:false, message:'Upload a suburb header photo before approving'}`** (server-side gate per spec §7); approve → `{approval_status:'approved', is_active:true, published_at: atsNowIso()}`; reject → `{approval_status:'rejected', is_active:false}`. Response `{ok:true, job: atsJobCard(updated,{},{})}`.

UI in `js/ceo-ats-jobs.js`:
- `jobCardHtml`: when `j.approval_status==='pending'` add amber pill `Pending approval`; `'rejected'` grey pill.
- New **“Review & approve”** section in the job settings modal (or a dedicated modal opened from a button on pending job cards, `data-ats-approve-job`): shows current header image (or "No photo yet"), file input (base64 pattern verbatim from `ceoDocUpload`, ceo-dashboard.html:5488) posting to header-image endpoint, a **per-suburb reuse picker** (`GET /api/ats/suburb-images` → thumbnails; click → PATCH via header-image endpoint? No — add `body {reuse_url}` support to `POST /api/ats/job/header-image` that skips upload and just PATCHes the job with an existing URL), and Approve (disabled until image present — client mirror of the server gate) / Reject buttons → `POST /api/ats/job/approve`. On approve success: `ATS.toast('Job approved — now visible to GPs')` + reload list.
- Jobs list fetch: `GET /api/ats/jobs` uses `atsListJobRows()` = active-only → pending jobs (is_active=false) would be invisible to admins. **Fix:** in the `/api/ats/jobs` handler add pending rows: when Supabase, also fetch `career_roles` where `approval_status=eq.pending`; local: include `dbState.atsJobs` rows with `approval_status==='pending'`. Merge before carding.

- [ ] **Step 1:** Server endpoints + `atsJobCard` fields + pending-row merge. **Step 2:** `node --check`. **Step 3:** UI + cache-buster.
- [ ] **Step 4: Manual smoke (local):** sign a practice (Task 6 curls) → job pending; approve without image → 400 with exact message; upload 1×1 PNG data URL → ok; approve → `is_active:true`; verify in `data/app-db.json`.
- [ ] **Step 5: Commit + push** `feat(pipeline): job approval flow with mandatory suburb header photo + per-suburb reuse picker`

---

### Task 10: Identity masking everywhere + `canRevealPracticeIdentity`

**Files:**
- Modify: `server.js` — `PUBLIC_JOB_FIELDS` (17348), `mapCareerRoleRowToPublicJob` (17359), `mapCareerRoleRowToClient` (17248) + detail mapper (17315), `/api/career/my-offer` serializer (28697-28805); new helper `canRevealPracticeIdentity(userId, careerRoleId)`.
- Modify: `pages/site-jobs.html` (buildJobCard 312), `pages/site-job.html` (renderJob 299), `pages/job.html`, `pages/career.html`, `pages/offer-review.html`.

**Interfaces:**
- `canRevealPracticeIdentity(userId, careerRoleId) => Promise<boolean>`: find the user's application for that role (Supabase `gp_applications user_id=eq.&career_role_id=eq.` / local scan), load offer via `atsOffersStore.getAtsOfferByApplication(app.id)`, return `practicePipeline.canRevealPracticeIdentityCore({application:app, offer})`. Missing `revealed`/`origin` columns → treated as absent (undefined) — core rule still works via accepted-offer fallback.
- Public API: remove `'practice_name'` from `PUBLIC_JOB_FIELDS`; add `'display_label'`, `'header_image_url'`, `'suburb'`, `'nearest_city'`. In the mapper: `title: row.masked_title || row.title`, `display_label: practicePipeline.buildMaskedDisplayLabel({billingStyle: row.billing_model, dpa: !!row.dpa, nearestCity: row.nearest_city || row.location_city})`, drop the `practice_name` key entirely, add `header_image_url`, `suburb`, `nearest_city`. ALSO defensively filter `approval_status`: in `getActivePublicJobRowsLive` (17486) keep `is_active=eq.true` and add client-side `.filter(r => !r.approval_status || r.approval_status === 'approved')`.
- In-app list serializer `mapCareerRoleRowToClient`: `practiceName: row.masked_title || gpLinkMeta.publicHeadline || 'Confidential GP practice'` and add `headerImageUrl: row.header_image_url || ''`, `displayLabel: buildMaskedDisplayLabel(...)`, `dpa: !!row.dpa`, `state: row.location_state`, `qualifies: true` (default; Task 11 overrides). Roles feed filter: in `/api/career/roles` (28114) add `.filter(r => !r.approval_status || r.approval_status === 'approved')` on stored rows.
- `/api/career/role` detail (28227): after building the payload, `const revealed = await canRevealPracticeIdentity(userId, row.id)`; when revealed: add `revealed:true, realPracticeName: row.practice_name, practiceAddress: <practices.address via atsGetPracticeRow(row.practice_id)>, revealedMapQuery: [address, suburb, state].filter(Boolean).join(', ')`.
- `/api/career/my-offer` (28697): gate the existing reveal — `const revealed = await canRevealPracticeIdentity(userId, moRole && moRole.id)`; when NOT revealed: `practiceName = (moRole && (moRole.masked_title || '')) || 'Confidential practice'`, `location` = suburb/state only, `practiceContact.name = 'The practice team'`; when revealed: current behavior + add `practiceAddress`, `revealedMapQuery` (address z=15), `headerImageUrl`, `revealed:true`, `interviewBookable` (Task 12 sets real logic; here default `revealed && offer.status !== 'declined'`).
- `pages/site-jobs.html` buildJobCard: replace the `jc-practice` practice_name div with `job.display_label`; show `header_image_url` as a card thumbnail when present (`<div class="jc-hero"><img …></div>`, `object-fit:cover;height:120px;border-radius:10px`).
- `pages/site-job.html` renderJob: hero `<img>` at top when `header_image_url`; meta line uses `display_label` (practice span removed); add "Practice Profile" block rendering `dpa` ("DPA Location: Yes/No"), `mmm`, billing, and a **suburb map iframe** `https://www.google.com/maps?q=<suburb>+<location_state>&z=12&output=embed` when `suburb` present.
- `pages/career.html` + `pages/job.html`: role modal/hero — when `role.headerImageUrl` set, use it instead of `/api/career/hero-image`; display `role.displayLabel` under the headline. When role detail returns `revealed:true`: show `realPracticeName` and switch the map iframe to `revealedMapQuery` with `z=15`.
- `pages/offer-review.html`: `renderOffer` — when `data.revealed`: keep practice name + add an exact-address map iframe `<iframe id="revealMapFrame">` (`?q=<encoded revealedMapQuery>&z=15&output=embed`) below the practice card; when not revealed the API already sends masked values so no page change needed for masking. Cache-busters `?v=20260705a` on any changed shared js (these pages use inline scripts — bump nothing else).

- [ ] **Step 1: Extend tests** in `tests/practice-pipeline.test.js`: masked public-job shape — write a small local copy test asserting `buildMaskedDisplayLabel` output; reveal-core matrix already covered in Task 2 (add any missed case: revealed=false+origin gp_applied+offer sent → false).
- [ ] **Step 2:** Server edits. `node --check`. **Step 3:** Page edits.
- [ ] **Step 4: Manual smoke (local):** approve the Task-9 job, then `curl /api/public/jobs` → response contains `display_label`, `masked_title`-based `title`, and **NO `practice_name` key**; grep the JSON for the real practice name → zero hits. Record output.
- [ ] **Step 5: Commit + push** `feat(pipeline): centralized identity reveal + practice name/address masked on all public + in-app surfaces`

---

### Task 11: Onboarding "Australia trained" + DPA gate + tailored/blurred GP list

**Files:**
- Modify: `js/onboarding.js` (defaultState 59; step gating; save), `pages/onboarding.html` (step 1 slide ~1067), `server.js` (`/api/onboarding/complete` mirror 33580; `/api/career/roles` 28114), `pages/career.html` (blurred cards), `pages/job.html` (skip blurred roles in its list if it renders one).

**Interfaces:**
- Onboarding: `defaultState()` gains `australiaTrained: null`. Step 1 slide gains, under the country list, a radio pair `name="trainedWhere"` — label **“Where did you complete your GP training?”**, options “Australia” / “Overseas” — bound to `state.australiaTrained = (v==='au')`; required to proceed past step 1 (extend the existing step-1 gate that currently requires `country`). Saved automatically via the existing `saveState()` POST of the whole blob. `/api/onboarding/complete`: add `if (typeof body.australiaTrained === 'boolean') profileUpdate.australia_trained = body.australiaTrained;` (33580 block).
- Server GP profile read (new helper near `_resolveGpCountry` 3286): `async _resolveGpJobsProfile(userId, email)` → `{ australiaTrained:boolean, preferredCity:string }` from `user_profiles.{australia_trained, preferred_city}` with fallback to `user_state.state.gp_onboarding.{australiaTrained, preferredCity}`; default `{australiaTrained:false, preferredCity:''}`.
- `/api/career/roles` (28114): after building the client roles array (each mapped role now carries `dpa`, `state`, `nearest_city` per Task 10), apply:
```js
      const gpProfile = await _resolveGpJobsProfile(userId, email);
      const gated = clientRoles.map(r => Object.assign(r, practicePipeline.gpQualifiesForRole({ dpa: r.dpa }, { australiaTrained: gpProfile.australiaTrained })));
      const qualifying = practicePipeline.rankRolesForGp(gated.filter(r => r.qualifies), { preferredCity: gpProfile.preferredCity });
      const blurred = gated.filter(r => !r.qualifies).map(r => practicePipeline.buildRedactedRoleStub(r));
      payload.roles = qualifying.concat(blurred);
```
  (`rankRolesForGp` must accept already-serialized client roles — match on `r.nearest_city || r.majorCity || r.location` and `r.state`; adjust the Task-2 implementation/tests accordingly if field names differ.)
- `/api/career/apply` (28808): reject `roleId` that resolves to a role failing `gpQualifiesForRole` for this user → 403 `{ok:false, error:'not_qualified'}` (server-side enforcement, not just hiding). Also add `origin:'gp_applied'` to `appRow` with missing-column retry.
- `pages/career.html`: role card renderer — when `role.blurred`: add class `role-card--blurred`; CSS: `.role-card--blurred .role-card-body{filter:blur(6px);pointer-events:none;user-select:none}` + absolutely-positioned overlay `<div class="role-blur-overlay">You don't currently qualify for this role</div>` (centered, white pill, `font-weight:700`); the card itself non-interactive (no modal open — guard the click handler on `role.blurred`). Blurred roles excluded from the location/billing filters (always appended at the end of `getFilteredRoles` output: modify it to `return qualifying.filter(...).concat(blurredRoles)`).
- `pages/job.html` list: skip `blurred` roles entirely (it's a single-role page pattern — just guard `renderRole` against blurred stubs with a "role unavailable" message).

- [ ] **Step 1: Tests first** — extend `tests/practice-pipeline.test.js`: `gpQualifiesForRole` + `rankRolesForGp` against client-role-shaped objects (`{nearest_city, state, published_at}`); stub leaks nothing. Run → green after implementing tweaks.
- [ ] **Step 2:** Onboarding UI + save mirror. **Step 3:** Server gate + ranking + apply enforcement. `node --check`.
- [ ] **Step 4: Manual smoke (local):** seed local user via existing dev signin (local mode OTP flow), set onboarding blob `australiaTrained:false` directly in `data/app-db.json`, curl `/api/career/roles` with the session cookie → non-DPA jobs appear only as blurred stubs with no identifying fields; flip to `true` → full list. Record output. (If local session cookie proves impractical via curl, verify via a temporary vitest-style unit call of the pure pipeline and browser-verify in Task 13 — say which happened.)
- [ ] **Step 5: Commit + push** `feat(pipeline): Australia-trained onboarding question + server-side DPA gate + preferred-city ranking + blurred non-qualifying fillers`

---

### Task 12: Acceptance trigger → reveal + confetti congrats + email

**Files:**
- Modify: `server.js` — `POST /api/ats/application/accept` (new, next to POST /api/ats/application 47967); `POST /api/ats/application` (admin apply: origin + reveal + congrats); `/api/career/my-offer` add `interviewBookable`; `js/ceo-ats-candidates.js` + `js/ceo-ats-jobs.js` (accept button in candidate drawer); `pages/offer-review.html` (confetti + Secure My Interview button + revealed block); `pages/ceo-dashboard.html` cache-busters → `?v=20260705a`.

**Interfaces:**
- `POST /api/ats/application/accept?id=` — `requireAtsSession`. Load app context (`atsGetApplicationContext`, used by /api/ats/offer 48005). Steps: PATCH `gp_applications` `{revealed:true, practice_submission_status:'client_approved'}` (missing-column tolerant); `atsOffersStore.saveAtsOffer({ application_id, user_id, career_role_id, practice_id, job_title, practice_name, billing_split: <intake.percentage_split from role.source_payload.intake>, status:'sent', sent_by: ctx.email, sent_at: atsNowIso(), notes:'Practice accepted — interview invitation' })`; `atsUpdateApplicationStageRow(appId, 'offer', undefined, 'practice_accept')`; send congrats (below); `{ok:true}`.
- Admin apply `POST /api/ats/application` (47983 aaRow): add `origin:'admin_applied', revealed:true` to `aaRow` with the missing-column retry pattern; after successful insert ALSO `saveAtsOffer` (same shape, notes `'Admin placed this GP with the practice'`) and send congrats.
- Congrats sender `async sendGpCongratsEmail(userId, applicationId, practiceName)`: `secureUrl = APP_BASE_URL + '/pages/secure-interview?applicationId=' + encodeURIComponent(applicationId)`; copy via `practicePipeline.buildCongratsEmailCopy`; send via `sendGpNotificationEmail` (same helper as notifyGpOfferSent 25270 — CTA 'Secure My Interview' → secureUrl) + `pushCareerNotificationToUser` + `sendPushNotification` (mirror notifyGpOfferSent's Promise.all/catch shape).
- `/api/career/my-offer`: add `interviewBookable: revealed && offer.status !== 'declined' && offer.status !== 'withdrawn' && !<already-booked>` where already-booked = a `scheduled_calls` row `meeting_kind=eq.interview&application_id=eq.<id>&status=eq.booked` (local scan fallback); when booked add `bookedInterview: { scheduled_at, zoom_join_url }`.
- `pages/offer-review.html`:
  - Self-contained confetti (~50 lines inline JS, CSP-safe, no lib): fixed-position `<canvas id="confettiCanvas">`, 140 rects in GP-Link palette (`#2563eb,#22c55e,#f59e0b,#ef4444,#a855f7`), randomized x/vy/rotation, `requestAnimationFrame` loop ~2.8 s then canvas removed. `function launchConfetti()` invoked when the page loads with `data.revealed && (data.offer.status==='sent' || data.offer.status==='accepted')` (i.e. both the congrats state and the accepted state).
  - Prominent **“Secure My Interview”** button `#secureInterviewBtn` (blue, full-width) shown when `data.interviewBookable`, href `/pages/secure-interview?applicationId=<applicationId>`; when `data.bookedInterview` show the booked time + Zoom link instead.
  - Revealed practice block: real name (already in `practiceName` when revealed), `practiceAddress` line, exact-address map iframe `z=15`, `headerImageUrl` hero when present.
- CEO UI: in the candidate drawer (`openCandidateDrawer`, ceo-ats-jobs.js:361-409) add button **“✅ Practice accepted — reveal & congratulate”** (`data-ats="accept-application" data-id`) → confirm dialog → `ATS.api('/api/ats/application/accept?id='+id, {method:'POST'})` → toast + reload board. Mirror the same action in `js/ceo-ats-candidates.js` candidate detail actions.

- [ ] **Step 1:** Server endpoint + admin-apply changes + congrats sender. `node --check`.
- [ ] **Step 2:** offer-review confetti + button + revealed block; CEO buttons; cache-busters.
- [ ] **Step 3: Manual smoke (local):** apply a local GP to the approved job via `POST /api/ats/job/candidate` or admin apply, hit accept endpoint (admin session), then curl `/api/career/my-offer?applicationId=` with the GP session → `revealed:true`, `interviewBookable:true`, real practice name + address present. Record output.
- [ ] **Step 4: Commit + push** `feat(pipeline): practice-accept + admin-apply reveal identity, record offer, confetti congrats + Secure My Interview email`

---

### Task 13: Secure My Interview — instant GP booking

**Files:**
- Modify: `server.js` — extract shared interview helpers from the admin endpoints (48192-48430) and add `GET /api/career/interview/slots`, `POST /api/career/interview/book`.
- Create: `pages/secure-interview.html`.

**Interfaces:**
- Refactor (no behavior change to admin endpoints): extract from `GET /api/ats/interview/slots` a fn `async _interviewSlotContext(applicationId, nowMs)` → `{ app, role, practice, meetingRow, slots }` and from `POST /api/ats/interview/book` a fn `async _bookInterviewSlot(meetingRow, app, slotStartUtc, nowMs)` → `{ booked, zoom, gcal }` (Zoom `createZoomInterviewMeeting` 24261 → `gcalCreateEvent` 24245 → PATCH `scheduled_calls` `{status:'booked', scheduled_at, zoom_*, gcal_event_id}` → stage advance to `'interview'` via `atsUpdateApplicationStageRow` → confirm emails). Admin endpoints call the extracted fns; assert existing tests still pass.
- `GET /api/career/interview/slots?applicationId=` — `requireSession`; app must belong to the session user (404 otherwise) AND `canRevealPracticeIdentity` true (403 `not_available`); find the app's interview `scheduled_calls` row; **when none exists create one** via `interviewMeetings.buildInterviewRow(...)` + `insertScheduledCallRow` then PATCH `{practice_availability_status:'defaulted'}` so slots compute against `DEFAULT_PRACTICE_CONFIG` (GP books immediately; no practice-availability round-trip — spec: books on the spot); return `{ok:true, slots}` (each `{startUtc, endUtc, local:{gp:{tz,label}}}`).
- `POST /api/career/interview/book` body `{applicationId, slot_start_utc}` — same guards; re-validate slot against a fresh `maxSlots:500` compute (mirror admin book); call `_bookInterviewSlot`; respond `{ok:true, booked:{scheduled_at, zoom_join_url}}`; 409 `slot_taken` when stale.
- `pages/secure-interview.html`: auth-guarded GP page (include `js/auth-guard.js?v=20260705a` + `js/nav-shell-bridge.js` like `pages/offer-review.html`'s head — copy its include block). Reads `applicationId` from query (deep link survives sign-in via the existing `?next` pattern automatically — auth-guard.js:172 captures path+query). Loads slots → renders grouped-by-day slot buttons with the GP's local labels (`slot.local.gp.label`) → click → confirm sheet → POST book → success state: mini confetti (reuse the Task-12 inline confetti fn), "Interview locked in 🎉", date/time in GP tz, Zoom join link button, "It's on your calendar — invite sent to your email." Errors: `slot_taken` → toast + reload slots; `not_available` → friendly redirect to `/pages/offer-review`.

- [ ] **Step 1:** Refactor-extract admin helpers; `node --check`; run full suite `PATH="$NODEBIN:$PATH" npx vitest run` → count must match pre-refactor (record numbers).
- [ ] **Step 2:** GP endpoints + page.
- [ ] **Step 3: Manual smoke (local):** with Task-12's accepted application + GP session cookie: curl slots → ≥1 slot (local mode: gcal/zoom fall back to `dbState.fakeCalendar` + `zoom_local_*` ids per research); book first slot → `{ok:true, booked:{...}}`; verify `scheduled_calls`-equivalent local row `status:'booked'` and app `ats_stage:'interview'`; re-book → `already booked` behavior (booked info returned). Record real outputs.
- [ ] **Step 4: Commit + push** `feat(pipeline): Secure My Interview — GP-facing instant Zoom booking via the 3-way scheduler`

---

### Task 14: End-to-end verification, full test suite, PR

- [ ] **Step 1:** `PATH="$NODEBIN:$PATH" npx vitest run` — full suite green; paste the real summary line.
- [ ] **Step 2: Full manual E2E in local mode** (server on :3000, honest narration of every step): FB webhook curl → practice prospective + intake email attempt logged (Resend key absent locally → `{ok:false,error:'Email not configured'}` is the EXPECTED honest result; state it) → open practice-intake page with token in a browser if available, else curl the HTML + drive the APIs → intake POST → sign POST (PNG data URL) → practice active + job pending → approve blocked without photo (exact 400 message) → header-image upload → approve → `/api/public/jobs` masked (no practice_name anywhere) → GP roles list: overseas GP sees non-DPA job blurred stub; australiaTrained sees it fully → admin accept → my-offer revealed + interviewBookable → slots → book → booked. Record every real response.
- [ ] **Step 3:** Update `docs/standalone-ats.md` (or add `docs/practice-client-pipeline.md`) documenting: the flow, new endpoints, env vars (`FB_LEAD_WEBHOOK_SECRET`, `FB_LEAD_VERIFY_TOKEN`), the migration file + exec_sql application step, and the Zapier fallback payload contract.
- [ ] **Step 4:** Push + `gh pr create --draft` (or `git push` + note if gh unavailable — research says no gh CLI on this machine; then create the PR body in the final message instead). PR body: plain-English summary (practice / GP / admin experience), the deferred DDL application step, and the manual prod checklist (set FB env vars, apply migration, verify Resend).

## Self-review notes (done during planning)
- Spec coverage: §0 asset ✔ (committed Task 1); §1 migrations ✔ T1; §2 webhook+CEO grouping ✔ T4/T8; §3 email ✔ T4; §4 click-form ✔ T5/T7; §5 sign ✔ T6 (+approval T9); §6 masking helper ✔ T2/T10; §7 header image mandatory ✔ T9 (+display T10); §8 onboarding+DPA+blur ✔ T11; §9 congrats+confetti+secure-interview ✔ T12/T13; §11 tests+e2e ✔ every task + T14.
- Type consistency: reveal helper name `canRevealPracticeIdentity(userId, careerRoleId)` (server) wrapping `canRevealPracticeIdentityCore({application, offer})` (lib) — used identically in T10/T12/T13. `INTAKE_FIELDS` single source used by T5 (validation) and T7 (form). Masked label builder shared T2→T10.
- Known honest limitations to restate in the final report: emails and Zoom/GCal are stubbed in local mode; prod DDL application + FB webhook subscription + Resend/Zoom env checks are deploy-time steps; browser click-through of the two new pages should be done by the owner or a follow-up live test.
