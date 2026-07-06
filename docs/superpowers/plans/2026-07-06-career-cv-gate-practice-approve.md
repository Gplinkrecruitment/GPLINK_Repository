# Career CV Gate + Practice Approve/Turn-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate career browsing behind an AI-verified careers CV (+ optional cover letter), fix the practice submission email to attach only that verified CV, enrich it with a profile-driven candidate intro + AI 3-sentence recommendation, and add one-click Approve / Turn Down buttons for the practice that flow into the existing interview scheduler.

**Architecture:** All server work lands in `server.js` (monolith convention) plus one new pure module `lib/career-intro.js`. The gate modal lives inline in `pages/career.html` (per-page inline script/style convention). A new public page `pages/practice-decision.html` serves the emailed Approve/Turn-Down links, token-authenticated against a new `gp_applications.practice_action_token` column. Interview scheduling reuses the existing `scheduled_calls` machinery (`lib/interview-meetings.js`, `_interviewSlotContext`, `_bookInterviewSlot`) — the practice submits availability windows which set `practice_availability_status='received'`, then the GP books via the existing `/api/career/interview/*` endpoints.

**Tech Stack:** Vanilla JS/HTML, Node `server.js` monolith, Supabase (PostgREST) + local-JSON dual mode, Resend email, Anthropic Messages API, vitest.

**Approved visual:** `docs/mockups/career-cv-gate-practice-email.html` (committed in Task 1). Copy, layout, gold "exclusive edge" styling, button hierarchy and email structure MUST follow this mockup.

## Global Constraints

- **Pathway wording:** default pathway label is exactly `Expedited Specialist Pathway`; `account_status === 'pep_waitlist'` → `Practice Experience Program (PEP) pathway`. Never say "RACGP Specialist Pathway".
- **Cover-letter booster copy (verbatim):** "GPs with a cover letter are **150% more likely** to be offered a position by medical centres." Kicker: "Your exclusive edge".
- **Document keys:** careers CV = `career_cv`, cover letter = `career_cover_letter`, both stored in `user_documents` with `country_code = ACCOUNT_CAREER_DOCUMENT_COUNTRY` (`'AU'`, server.js:5789) and `status: 'uploaded'`.
- **Email attachments must NEVER come from registration-file documents.** Attachment source order: `career_cv` (status `uploaded`) → legacy fallback `cv_signed_dated` **with `status=eq.uploaded` filter** (this filter is the bug fix). Cover letter attaches when present. No other keys.
- **Email action links must not mutate on GET** (Outlook SafeLink prefetch — same rule as `/api/onboarding-reminders/unsubscribe`, server.js:25298). All mutation via POST from the landing page.
- **New Anthropic calls:** guard with `await checkAnthropicBudget()`, record usage with `recordAnthropicSpend(...)`, and use the new `ANTHROPIC_MESSAGES_URL` const (env-overridable for tests). CV scan uses `ANTHROPIC_SCAN_MODEL`; recommendation uses `ANTHROPIC_MODEL`.
- **Rate limiting:** CV AI scans capped per user per day via DB-backed `checkRateLimitWindow('career-cv-scan:'+userId, CAREER_CV_SCAN_MAX_PER_DAY, 24*60*60*1000)` (helper at server.js:9184 region; default cap 5). Practice-decision endpoints capped per-IP 30/hour via `checkRateLimitWindow('practice-decision-ip:'+ip, 30, 60*60*1000)`.
- **Dual-mode:** every new endpoint must work in Supabase mode (tests use the PostgREST emulator pattern from `tests/career-dpa-gate.test.js`). Local-JSON fallbacks follow the existing `isSupabaseDbConfigured()` branching where the touched code already has it.
- **Cache busters:** any changed `pages/career.html` script/style includes bump to `?v=20260707a`.
- **Commit + push after every task** (CLAUDE.md rule 6). Branch: `worktree-career-cv-gate-practice-approve`.
- **Upload size:** request bodies over ~4.5 MB are rejected by the platform; base64 inflates ~33% → client-side max file size 3 MB with a clear message.
- **Plain-language copy** everywhere a GP or practice reads text (owner rule).

---

### Task 1: Groundwork — mockup, migration, URL consts, Resend override

**Files:**
- Create: `docs/mockups/career-cv-gate-practice-email.html` (already copied into the worktree — just commit it)
- Create: `supabase/migrations/20260707150000_career_cv_practice_decision.sql`
- Modify: `server.js` (const block near line 205-219; `sendEmail` at line 22283-22292)

**Interfaces:**
- Produces: `gp_applications` columns `practice_action_token`, `practice_decision`, `practice_decision_at`, `practice_decision_reason`, `ai_recommendation` (all nullable text / timestamptz) used by Tasks 6-8.
- Produces: `ANTHROPIC_MESSAGES_URL` and `RESEND_API_URL` consts + `CAREER_CV_SCAN_MAX_PER_DAY` used by Tasks 3, 6.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260707150000_career_cv_practice_decision.sql
-- Career CV gate + practice Approve/Turn-Down (2026-07-06 plan)
-- Adds practice one-click decision plumbing to gp_applications.
-- The careers CV / cover letter reuse user_documents with new document_key
-- values ('career_cv', 'career_cover_letter') — no schema change needed there.

alter table public.gp_applications
  add column if not exists practice_action_token text,
  add column if not exists practice_decision text,
  add column if not exists practice_decision_at timestamptz,
  add column if not exists practice_decision_reason text,
  add column if not exists ai_recommendation text;

create index if not exists gp_applications_practice_action_token_idx
  on public.gp_applications (practice_action_token)
  where practice_action_token is not null;
```

- [ ] **Step 2: Add consts to server.js** (immediately after the `ANTHROPIC_DAILY_LIMIT_USD` const around server.js:219)

```js
// Anthropic Messages endpoint — env-overridable so tests can point new AI
// call sites at a local emulator. Existing call sites keep their inline URL.
const ANTHROPIC_MESSAGES_URL = process.env.ANTHROPIC_MESSAGES_URL || 'https://api.anthropic.com/v1/messages';
// Careers CV genuine-document scans allowed per GP per rolling 24h.
const CAREER_CV_SCAN_MAX_PER_DAY = Number(process.env.CAREER_CV_SCAN_MAX_PER_DAY || 5);
// Resend endpoint — env-overridable so tests can capture outbound email.
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
```

- [ ] **Step 3: Point `sendEmail` at `RESEND_API_URL`** — in `sendEmail` (server.js ~22283) replace the literal `'https://api.resend.com/emails'` in the `fetch(...)` call with `RESEND_API_URL`. No other behavior change. Also grep `api.resend.com` for the scheduled-email variant(s) and switch those fetches to the same const (there are 1-3 call sites; change them all so tests capture every send).

- [ ] **Step 4: Sanity check** — `node --check server.js` passes; `npx vitest run tests/oauth.test.js` passes (proves env/import order untouched).

- [ ] **Step 5: Commit**

```bash
git add docs/mockups/career-cv-gate-practice-email.html supabase/migrations/20260707150000_career_cv_practice_decision.sql server.js
git commit -m "feat(career): groundwork — decision columns migration, overridable AI/Resend URLs, scan cap const"
git push -u origin worktree-career-cv-gate-practice-approve
```

---

### Task 2: `lib/career-intro.js` — candidate intro builder (pure, TDD)

**Files:**
- Create: `lib/career-intro.js`
- Test: `tests/career-intro.test.js`

**Interfaces:**
- Produces: `buildCandidateIntro(opts)` consumed by Task 6.
  - `opts = { gpName, countryCode, accountStatus, specialty, targetDate, practiceName, roleTitle }` (all strings, any may be empty)
  - Returns `{ paragraph: string, facts: Array<{icon: string, label: string}>, pathwayLabel: string, startDateLabel: string }`
- Produces: `formatTargetDate(value) -> 'November 2026' | ''` (exported for reuse/tests).

- [ ] **Step 1: Write failing tests**

```js
// tests/career-intro.test.js
import { describe, it, expect } from 'vitest';
import { buildCandidateIntro, formatTargetDate } from '../lib/career-intro.js';

describe('formatTargetDate', () => {
  it('formats YYYY-MM', () => expect(formatTargetDate('2026-11')).toBe('November 2026'));
  it('formats YYYY-MM-DD', () => expect(formatTargetDate('2026-11-15')).toBe('November 2026'));
  it('returns empty for junk', () => {
    expect(formatTargetDate('')).toBe('');
    expect(formatTargetDate('soon')).toBe('');
    expect(formatTargetDate(null)).toBe('');
  });
});

describe('buildCandidateIntro', () => {
  const base = {
    gpName: 'Smith Miller', countryCode: 'uk', accountStatus: '',
    specialty: 'MRCGP — General Practice', targetDate: '2026-11',
    practiceName: 'SOP Medical Centre', roleTitle: 'General Practitioner (VR)'
  };
  it('builds the expedited-pathway paragraph', () => {
    const out = buildCandidateIntro(base);
    expect(out.pathwayLabel).toBe('Expedited Specialist Pathway');
    expect(out.paragraph).toContain('Dr Smith Miller');
    expect(out.paragraph).toContain('United Kingdom');
    expect(out.paragraph).toContain('Expedited Specialist Pathway');
    expect(out.paragraph).toContain('November 2026');
    expect(out.paragraph).not.toContain('RACGP');
  });
  it('uses PEP label for pep_waitlist accounts', () => {
    const out = buildCandidateIntro({ ...base, accountStatus: 'pep_waitlist' });
    expect(out.pathwayLabel).toBe('Practice Experience Program (PEP) pathway');
  });
  it('emits facts chips with flag / pathway / start date', () => {
    const out = buildCandidateIntro(base);
    const labels = out.facts.map((f) => f.label).join(' | ');
    expect(labels).toContain('Trained in the UK');
    expect(labels).toContain('Expedited Specialist Pathway');
    expect(labels).toContain('Nov 2026');
  });
  it('omits the start-date sentence and chip when targetDate missing', () => {
    const out = buildCandidateIntro({ ...base, targetDate: '' });
    expect(out.paragraph).not.toContain('commence');
    expect(out.facts.some((f) => /Available/.test(f.label))).toBe(false);
  });
  it('survives fully-empty input', () => {
    const out = buildCandidateIntro({});
    expect(typeof out.paragraph).toBe('string');
    expect(Array.isArray(out.facts)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/career-intro.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement `lib/career-intro.js`**

```js
'use strict';
// Builds the plain-language candidate introduction used in the
// submit-to-practice email. Pure module — no I/O — so it is unit-testable.

var COUNTRY_META = {
  uk: { name: 'the United Kingdom', shortName: 'the UK', flag: '\u{1F1EC}\u{1F1E7}', trained: 'Trained in the UK' },
  gb: { name: 'the United Kingdom', shortName: 'the UK', flag: '\u{1F1EC}\u{1F1E7}', trained: 'Trained in the UK' },
  ie: { name: 'Ireland', shortName: 'Ireland', flag: '\u{1F1EE}\u{1F1EA}', trained: 'Trained in Ireland' },
  nz: { name: 'New Zealand', shortName: 'New Zealand', flag: '\u{1F1F3}\u{1F1FF}', trained: 'Trained in New Zealand' }
};
var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function countryMeta(code) {
  var k = String(code || '').trim().toLowerCase();
  if (k === 'united kingdom' || k === 'great britain') k = 'uk';
  if (k === 'ireland') k = 'ie';
  if (k === 'new zealand') k = 'nz';
  return COUNTRY_META[k] || null;
}

function formatTargetDate(value) {
  var s = String(value || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!m) return '';
  var monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return '';
  return MONTHS[monthIdx] + ' ' + m[1];
}

function pathwayLabelFor(accountStatus) {
  if (String(accountStatus || '').trim().toLowerCase() === 'pep_waitlist') {
    return 'Practice Experience Program (PEP) pathway';
  }
  return 'Expedited Specialist Pathway';
}

function buildCandidateIntro(opts) {
  var o = opts || {};
  var name = String(o.gpName || '').trim() || 'the candidate';
  var displayName = /^dr\b/i.test(name) ? name : 'Dr ' + name;
  var meta = countryMeta(o.countryCode);
  var pathway = pathwayLabelFor(o.accountStatus);
  var startLabel = formatTargetDate(o.targetDate);
  var specialty = String(o.specialty || '').trim();

  var bits = [];
  var lead = displayName + ' is a';
  if (meta) lead += 'n internationally trained GP from ' + meta.name;
  else lead += 'n internationally trained GP';
  if (specialty) lead += ' holding the ' + specialty.replace(/\s*—.*$/, '');
  lead += ', coming to Australia via the ' + pathway + '.';
  bits.push(lead);
  if (startLabel) {
    bits.push(displayName.split(' ')[0] + ' ' + name.split(' ').pop() + ' is hoping to commence work by ' + startLabel + ', with GP Link managing the registration process end-to-end.');
  } else {
    bits.push('GP Link is managing the registration process end-to-end.');
  }

  var facts = [];
  if (meta) facts.push({ icon: meta.flag, label: meta.trained });
  facts.push({ icon: '\u{1FA7A}', label: pathway + (specialty ? ' (' + specialty.split(' ')[0] + ')' : '') });
  if (startLabel) {
    var shortMonth = startLabel.slice(0, 3) + ' ' + startLabel.split(' ')[1];
    facts.push({ icon: '\u{1F4C5}', label: 'Available from ' + shortMonth });
  }

  return { paragraph: bits.join(' '), facts: facts, pathwayLabel: pathway, startDateLabel: startLabel };
}

module.exports = { buildCandidateIntro, formatTargetDate, pathwayLabelFor };
```

Note: the tests import with ESM `import` — vitest interops CJS module.exports fine (existing lib tests do the same; verify with `grep -l "from '../lib/" tests/ | head`).

- [ ] **Step 4: Run tests** — `npx vitest run tests/career-intro.test.js` → PASS. Adjust implementation (not tests) until green. Check the "Dr Smith Miller is hoping to commence" sentence reads naturally — the second sentence must start with `Dr <lastname>` (e.g. "Dr Miller is hoping to commence work by November 2026"): use `'Dr ' + name.split(' ').pop()`.

- [ ] **Step 5: Commit**

```bash
git add lib/career-intro.js tests/career-intro.test.js
git commit -m "feat(career): candidate intro builder — pathway/country/start-date sentences + fact chips"
git push
```

---

### Task 3: Career profile endpoints — status, CV upload with AI scan, cover letter (TDD)

**Files:**
- Modify: `server.js` (new handlers next to the `/api/career/apply` route around server.js:27890; helper functions near `saveAccountCareerDocumentForUser` at 6389)
- Test: `tests/career-profile-gate.test.js`

**Interfaces:**
- Consumes: `ANTHROPIC_MESSAGES_URL`, `CAREER_CV_SCAN_MAX_PER_DAY` (Task 1); existing `supabaseStorageUploadObject`, `checkRateLimitWindow`, `checkAnthropicBudget`, `recordAnthropicSpend`, `extractDocxTextWithMammoth`, `ANTHROPIC_SCAN_MODEL`.
- Produces (used by Tasks 4, 5):
  - `GET /api/career/profile/status` → `{ ok:true, cv: { fileName, updatedAt } | null, coverLetter: { fileName, updatedAt } | null, scanRemaining: number }`
  - `POST /api/career/profile/cv` body `{ fileName, fileBase64, mimeType, fileSize }` → 200 `{ ok:true, verified:true, fileName }` | 422 `{ ok:false, verified:false, reason, attemptsRemaining }` | 429 `{ ok:false, code:'rate_limited', message }`
  - `POST /api/career/profile/cover-letter` same body → `{ ok:true, fileName }`
  - Server helper `getCareerProfileDocument(userId, key)` → latest `user_documents` row with `status='uploaded'` for `career_cv`/`career_cover_letter`, or null.

**Auth:** all three routes authenticate exactly like `POST /api/career/apply` (mirror its session block — grep `'/api/career/apply'` and copy the session/userId resolution verbatim).

- [ ] **Step 1: Write failing tests** — model the file on `tests/career-dpa-gate.test.js`: PostgREST emulator + hand-signed `gp_session` cookie + real server on port 0. Add a second emulator for Anthropic + a Resend capture server. Skeleton (complete file):

```js
// tests/career-profile-gate.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server, baseUrl, sbServer, aiServer, aiMode = 'genuine_cv';
const db = {
  user_profiles: [{ user_id: 'u-gate-1', email: 'gate-gp@example.com', first_name: 'Gate', last_name: 'Tester', registration_country: 'uk' }],
  user_state: [{ user_id: 'u-gate-1', state: { gp_onboarding_complete: true } }],
  user_documents: [],
  rate_limits: [],
  gp_applications: [], career_roles: [], scheduled_calls: [], ats_offers: []
};
// startSupabaseEmulator: copy the emulator implementation verbatim from
// tests/career-dpa-gate.test.js (parseFilters/applyFilters/GET/POST/PATCH/DELETE
// over the `db` object) — keep it identical so behavior matches.
/* ... emulator code copied here ... */

function startAnthropicEmulator() {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const genuine = aiMode === 'genuine_cv';
      const payload = {
        content: [{ type: 'text', text: JSON.stringify({ isCv: genuine, reason: genuine ? 'Curriculum vitae with work history' : 'This appears to be an employment contract, not a CV' }) }],
        usage: { input_tokens: 100, output_tokens: 20 }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
}

function userCookie(email, userId) { /* copy verbatim from career-dpa-gate.test.js */ }
function httpReq(method, path, { cookie, body } = {}) { /* copy verbatim */ }

const PDF_B64 = Buffer.from('%PDF-1.4 fake cv for tests').toString('base64');

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-secret-' + RUN_ID;
  // start emulators first, then point env at them BEFORE importing server.js
  await startSupabaseEmulator();
  await startAnthropicEmulator();
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbServer.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.ANTHROPIC_MESSAGES_URL = `http://127.0.0.1:${aiServer.address().port}/v1/messages`;
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }));
});
afterAll(async () => { server?.close(); sbServer?.close(); aiServer?.close(); });

describe('career profile gate', () => {
  const cookie = () => userCookie('gate-gp@example.com', 'u-gate-1');

  it('status starts empty', async () => {
    const res = await httpReq('GET', '/api/career/profile/status', { cookie: cookie() });
    expect(res.status).toBe(200);
    expect(res.body.cv).toBeNull();
    expect(res.body.coverLetter).toBeNull();
    expect(res.body.scanRemaining).toBeGreaterThan(0);
  });

  it('rejects a non-CV upload and stores nothing', async () => {
    aiMode = 'not_cv';
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'contract.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 1000 } });
    expect(res.status).toBe(422);
    expect(res.body.verified).toBe(false);
    expect(res.body.reason).toMatch(/contract/i);
    expect(db.user_documents.filter((d) => d.document_key === 'career_cv')).toHaveLength(0);
  });

  it('accepts a genuine CV, stores it, status reflects it', async () => {
    aiMode = 'genuine_cv';
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'Smith-Miller-CV.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 1000 } });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    const rows = db.user_documents.filter((d) => d.document_key === 'career_cv' && d.status === 'uploaded');
    expect(rows).toHaveLength(1);
    const st = await httpReq('GET', '/api/career/profile/status', { cookie: cookie() });
    expect(st.body.cv.fileName).toBe('Smith-Miller-CV.pdf');
  });

  it('stores a cover letter without AI scan', async () => {
    const res = await httpReq('POST', '/api/career/profile/cover-letter', { cookie: cookie(), body: { fileName: 'CL.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 500 } });
    expect(res.status).toBe(200);
    expect(db.user_documents.filter((d) => d.document_key === 'career_cover_letter')).toHaveLength(1);
  });

  it('rate limits scans after the daily cap', async () => {
    aiMode = 'not_cv';
    let last;
    for (let i = 0; i < 10; i++) {
      last = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'x.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 100 } });
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
  });

  it('rejects oversized uploads', async () => {
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'big.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 5 * 1024 * 1024 } });
    expect(res.status).toBe(413);
  });

  it('requires auth', async () => {
    const res = await httpReq('GET', '/api/career/profile/status', {});
    expect([401, 403]).toContain(res.status);
  });
});
```

Storage note: `supabaseStorageUploadObject` will POST to the emulator's `/storage/v1/object/...` path — add a catch-all `res.end('{}')` 200 handler for `/storage/v1/` paths in the emulator. The `rate_limits` table name: **verify** what table `checkRateLimitWindow` uses (read server.js:9184-9214) and seed/emulate accordingly; if it uses an in-memory map in test mode, drop the `rate_limits` seed.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/career-profile-gate.test.js` → FAIL (404s on the new routes).

- [ ] **Step 3: Implement the server pieces.**

3a. Helper `verifyCareerCvWithAI(buffer, mimeType, fileName)` (place near `classifyDocumentWithAI`, server.js ~21040). Returns `{ ok, isCv, reason }`:

```js
// AI genuine-CV check for the careers profile gate. Returns
// { ok:false } when AI is unavailable (caller decides fallback),
// otherwise { ok:true, isCv:boolean, reason:string }.
async function verifyCareerCvWithAI(buffer, mimeType, fileName) {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, reason: 'ai_unconfigured' };
  if (!(await checkAnthropicBudget())) return { ok: false, reason: 'ai_budget' };
  var mime = String(mimeType || '').trim().toLowerCase();
  var blocks = [];
  if (mime === 'application/pdf') {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
  } else if (/^image\/(png|jpe?g|webp|gif)$/.test(mime)) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mime === 'image/jpg' ? 'image/jpeg' : mime, data: buffer.toString('base64') } });
  } else if (mime.includes('wordprocessingml') || /\.docx$/i.test(String(fileName || ''))) {
    var text = await extractDocxTextWithMammoth(buffer);
    if (!text) return { ok: true, isCv: false, reason: 'We could not read this Word file — please export your CV as a PDF and try again.' };
    blocks.push({ type: 'text', text: 'DOCUMENT TEXT (extracted from Word file):\n\n' + text.slice(0, 30000) });
  } else {
    return { ok: true, isCv: false, reason: 'Unsupported file type — please upload a PDF or Word document.' };
  }
  blocks.push({ type: 'text', text: 'Is the document above a genuine curriculum vitae / resume for a medical professional? A CV lists a person\'s career history, education and skills. Contracts, certificates, letters, forms and IDs are NOT CVs. Respond with ONLY valid JSON: {"isCv": true|false, "reason": "<short plain-English reason a non-technical person understands>"}' });
  try {
    var resp = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_SCAN_MODEL, max_tokens: 300, messages: [{ role: 'user', content: blocks }] })
    });
    var json = await resp.json();
    if (json && json.usage) recordAnthropicSpend(json.usage.input_tokens, json.usage.output_tokens, json.usage.cache_read_input_tokens, json.usage.cache_creation_input_tokens);
    var textOut = (json && json.content && json.content[0] && json.content[0].text) || '';
    var parsed = JSON.parse(textOut.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim());
    return { ok: true, isCv: parsed.isCv === true, reason: String(parsed.reason || '') };
  } catch (err) {
    console.error('[career-cv-scan] AI scan failed:', err && err.message);
    return { ok: false, reason: 'ai_error' };
  }
}
```

3b. Helper `saveCareerProfileDocument(userId, key, payload)` — mirror `saveAccountCareerDocumentForUser` (server.js:6389-6420) but with document keys `career_cv` / `career_cover_letter`, storage path `account-career/<AU>/<userId>/<key>/<timestamp>-<sanitized filename>`, and the full column set (`storage_bucket`, `storage_path`, `mime_type`, `file_size`). Reuse its upsert `Prefer: resolution=merge-duplicates&on_conflict=user_id,document_key,country_code` so re-uploads replace. Also implement `getCareerProfileDocument(userId, key)`:

```js
async function getCareerProfileDocument(userId, key) {
  if (isSupabaseDbConfigured()) {
    var r = await supabaseDbRequest('user_documents',
      'select=*&user_id=eq.' + encodeURIComponent(userId) +
      '&document_key=eq.' + encodeURIComponent(key) +
      '&status=eq.uploaded&order=updated_at.desc&limit=1');
    return (r.ok && Array.isArray(r.data) && r.data[0]) ? r.data[0] : null;
  }
  var rows = (dbState.userDocuments || []).filter(function (d) {
    return String(d.user_id) === String(userId) && d.document_key === key && d.status === 'uploaded';
  });
  rows.sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
  return rows[0] || null;
}
```

(Verify the local-JSON collection name for user_documents — grep `dbState.userDocuments` vs `dbState.user_documents`; use whichever exists, or Supabase-only if none does, matching how `saveAccountCareerDocumentForUser` behaves without Supabase.)

3c. Routes (place beside `/api/career/apply`):
- `GET /api/career/profile/status`: auth → `Promise.all([getCareerProfileDocument(userId,'career_cv'), getCareerProfileDocument(userId,'career_cover_letter')])` → also compute `scanRemaining` from the same rate-limit window used below (expose remaining = cap − count; if the helper can't report count, return the cap) → `sendJson(res, 200, { ok:true, cv, coverLetter, scanRemaining })` where `cv = row ? { fileName: row.file_name, updatedAt: row.updated_at } : null`.
- `POST /api/career/profile/cv`: auth → parse body → validate `fileBase64` present, `fileSize <= 3 * 1024 * 1024` else 413 `{ ok:false, message:'File is too large — please keep your CV under 3 MB.' }` → rate limit: `const rl = await checkRateLimitWindow('career-cv-scan:' + userId, CAREER_CV_SCAN_MAX_PER_DAY, 24*60*60*1000); if (!rl.allowed) return sendJson(res, 429, { ok:false, code:'rate_limited', message: 'You\'ve reached today\'s CV check limit — please try again tomorrow.' })` (**verify** `checkRateLimitWindow`'s exact return shape at server.js:9184 and adapt) → `verifyCareerCvWithAI(Buffer.from(fileBase64,'base64'), mimeType, fileName)`:
  - scan `ok:false` (AI down/unconfigured): **accept the upload** (do not block GPs on our outage) but log `console.warn('[career-cv-scan] scan unavailable, accepting unscanned:', reason)`.
  - `isCv:false`: 422 `{ ok:false, verified:false, reason: <AI reason>, attemptsRemaining: <cap - used> }`, store nothing.
  - `isCv:true` (or scan unavailable): `saveCareerProfileDocument(userId, 'career_cv', {...})` → 200 `{ ok:true, verified:true, fileName }`.
- `POST /api/career/profile/cover-letter`: auth → same size/type validation (pdf/docx/images) → save under `career_cover_letter` → 200 `{ ok:true, fileName }`. No AI scan, no rate limit (but require ≤ 3 MB).

- [ ] **Step 4: Run tests** — `npx vitest run tests/career-profile-gate.test.js` → PASS. Then `node --check server.js`.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/career-profile-gate.test.js
git commit -m "feat(career): profile gate endpoints — AI-scanned career CV + cover letter uploads, daily scan cap"
git push
```

---

### Task 4: Apply-gate switches to `career_cv` (TDD)

**Files:**
- Modify: `server.js:27918-27926` (the CV check inside `POST /api/career/apply`)
- Test: extend `tests/career-profile-gate.test.js`

**Interfaces:**
- Consumes: `getCareerProfileDocument` (Task 3).
- Produces: `/api/career/apply` 403 body `{ ok:false, requiresCv:true, message:'Please add your CV to your careers profile before applying.' }` consumed by Task 5's client handling.

- [ ] **Step 1: Write failing test** (append to `tests/career-profile-gate.test.js`; seed `career_roles` with one internal role the emulator serves, mirroring how `tests/career-internal-apply.test.js` seeds a role — copy its role fixture):

```js
describe('apply gate requires career_cv', () => {
  it('403 requiresCv when GP has legacy cv_signed_dated but no career_cv', async () => {
    db.user_documents.push({ id: 'doc-legacy', user_id: 'u-gate-2', document_key: 'cv_signed_dated', status: 'uploaded', country_code: 'uk', file_name: 'old.pdf', updated_at: '2026-01-01T00:00:00Z' });
    db.user_profiles.push({ user_id: 'u-gate-2', email: 'gate2@example.com', registration_country: 'uk' });
    db.user_state.push({ user_id: 'u-gate-2', state: { gp_onboarding_complete: true } });
    const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie('gate2@example.com', 'u-gate-2'), body: { roleId: SEEDED_ROLE_ID } });
    expect(res.status).toBe(403);
    expect(res.body.requiresCv).toBe(true);
  });
  it('apply succeeds once career_cv is uploaded', async () => {
    aiMode = 'genuine_cv';
    await httpReq('POST', '/api/career/profile/cv', { cookie: userCookie('gate2@example.com', 'u-gate-2'), body: { fileName: 'cv.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 900 } });
    const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie('gate2@example.com', 'u-gate-2'), body: { roleId: SEEDED_ROLE_ID } });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure** — the first test fails today because the legacy `cv_signed_dated` row satisfies the old check (`expect 403` gets 200).

- [ ] **Step 3: Implement** — replace the query block at server.js:27918-27926 with:

```js
// Careers profile gate: applying requires the AI-verified careers CV
// (document_key 'career_cv'), NOT registration-file documents.
const careerCvRow = await getCareerProfileDocument(userId, 'career_cv');
if (!careerCvRow) {
  sendJson(res, 403, { ok: false, message: 'Please add your CV to your careers profile before applying.', requiresCv: true });
  return;
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/career-profile-gate.test.js tests/career-internal-apply.test.js` → the new tests PASS. **If `career-internal-apply.test.js` fails** because its fixtures only seed `cv_signed_dated`: update those fixtures to seed a `career_cv` row instead — that is the intended new contract, not a regression. Note the fixture change in the commit message.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/
git commit -m "feat(career): /api/career/apply now requires the verified careers CV (career_cv)"
git push
```

---

### Task 5: Careers gate modal in `pages/career.html`

**Files:**
- Modify: `pages/career.html` (markup near the view panels ~line 7215; CSS near the `.modal` block ~5051; JS in the init flow ~11575 and `applyForRole` ~10197/`requiresCv` handling ~10224)

**Interfaces:**
- Consumes: `GET /api/career/profile/status`, `POST /api/career/profile/cv`, `POST /api/career/profile/cover-letter` (Task 3); `shouldLockCareerToSecuredView()` (career.html:8524).
- Produces: gate modal element `#careerGateModal`; function `openCareerGateModal()` reused by the apply handler.

**Visual source of truth:** Section 1 of `docs/mockups/career-cv-gate-practice-email.html` — reuse its class names (`gate-modal`, `gate-top`, `req-row`, `dropzone`, `boost`, `boost-medal`, `boost-kicker`, `scanline scan-checking|scan-ok|scan-bad`, `gate-cta`), CSS values (the gold `.boost` block with the `sheen` keyframes MUST be copied verbatim) and copy text. Prefix every class with `career-gate-` when inserting into career.html to avoid collisions (e.g. `.career-gate-boost`), keeping the property values identical.

- [ ] **Step 1: Add the modal markup** — insert before the closing of the main content container (next to the existing `#securedLifestyleExplorer` markup at ~7358):

```html
<div class="modal career-gate-modal" id="careerGateModal" aria-hidden="true" role="dialog" aria-label="Complete your careers profile">
  <div class="modal-card career-gate-card">
    <div class="career-gate-top">
      <div class="career-gate-kicker">One quick step</div>
      <h3>Complete your profile to start browsing careers</h3>
      <p>Medical centres see your CV the moment we introduce you — let’s make sure it’s ready.</p>
    </div>
    <div class="career-gate-body">
      <div class="career-gate-req">
        <div class="career-gate-req-ico">📄</div>
        <div class="career-gate-req-main">
          <div class="career-gate-req-title">Your CV <span class="career-gate-tag career-gate-tag-req">Required</span></div>
          <div class="career-gate-req-desc">PDF or Word, under 3 MB. This exact file is what practices receive with your introduction.</div>
          <label class="career-gate-dropzone" for="careerGateCvInput">
            <span class="career-gate-dz-btn">Upload CV</span>
            <span class="career-gate-dz-hint">PDF, DOC, DOCX · max 3 MB</span>
            <input type="file" id="careerGateCvInput" accept=".pdf,.doc,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
          </label>
          <div class="career-gate-scanline career-gate-scan-checking" id="careerGateScanChecking" hidden><span class="career-gate-spinner"></span>Checking this is a genuine CV…</div>
          <div class="career-gate-scanline career-gate-scan-ok" id="careerGateScanOk" hidden>✓&nbsp;<span id="careerGateScanOkText">CV verified</span></div>
          <div class="career-gate-scanline career-gate-scan-bad" id="careerGateScanBad" hidden><div>✕&nbsp;<span id="careerGateScanBadText"></span><small id="careerGateScanBadHint"></small></div></div>
        </div>
      </div>
      <div class="career-gate-req">
        <div class="career-gate-req-ico">✉️</div>
        <div class="career-gate-req-main">
          <div class="career-gate-req-title">Cover letter <span class="career-gate-tag career-gate-tag-opt">Optional</span></div>
          <div class="career-gate-req-desc">A short letter introducing yourself, sent alongside your CV.</div>
          <div class="career-gate-boost">
            <div class="career-gate-boost-medal">★</div>
            <div class="career-gate-boost-copy">
              <div class="career-gate-boost-kicker">Your exclusive edge</div>
              <span>GPs with a cover letter are <b>150% more likely</b> to be offered a position by medical centres.</span>
            </div>
          </div>
          <label class="career-gate-dropzone" for="careerGateClInput">
            <span class="career-gate-dz-btn career-gate-dz-btn-secondary">Add cover letter</span>
            <span class="career-gate-dz-hint" id="careerGateClHint">You can also add this later</span>
            <input type="file" id="careerGateClInput" accept=".pdf,.doc,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
          </label>
        </div>
      </div>
      <button class="career-gate-cta" id="careerGateCta" disabled>Upload your CV to continue</button>
      <div class="career-gate-foot">Your documents are only shared with practices when we introduce you to a role.</div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add the CSS** — copy Section-1 styles from the mockup into career.html's inline `<style>` (near `.modal` rules ~5051), renamed with the `career-gate-` prefix. Must include: the dark blue gradient header (`linear-gradient(135deg,var(--gp-blue-ink),var(--gp-blue))`), the gold `.career-gate-boost` block **verbatim from the mockup** (dark bronze gradient background, gold `border: 1px solid rgba(212,175,55,.55)`, the `::before` sheen sweep with `@keyframes career-gate-sheen`, radial-gradient medal, gold gradient text via `-webkit-background-clip:text`), scanline state styles, disabled/enabled CTA styles, and `.career-gate-modal.is-open{display:flex}`. Modal is NOT dismissible: no close button, no scrim-click close, `z-index` above the page (reuse the `.modal` base which is `position:fixed;inset:0;z-index:80`).

- [ ] **Step 3: Add the JS** (inline script, near the init IIFE ~11575):

```js
var careerGateState = { cvVerified: false, checked: false };
function careerGateEl(id) { return document.getElementById(id); }
function openCareerGateModal() { var m = careerGateEl('careerGateModal'); if (m) { m.classList.add('is-open'); m.setAttribute('aria-hidden', 'false'); } }
function closeCareerGateModal() { var m = careerGateEl('careerGateModal'); if (m) { m.classList.remove('is-open'); m.setAttribute('aria-hidden', 'true'); } }

function careerGateSetScanState(state, opts) {
  ['careerGateScanChecking', 'careerGateScanOk', 'careerGateScanBad'].forEach(function (id) { var el = careerGateEl(id); if (el) el.hidden = true; });
  if (state === 'checking') careerGateEl('careerGateScanChecking').hidden = false;
  if (state === 'ok') { careerGateEl('careerGateScanOk').hidden = false; careerGateEl('careerGateScanOkText').textContent = 'CV verified — ' + (opts && opts.fileName ? opts.fileName : 'your CV') + ' is ready to send to practices'; }
  if (state === 'bad') {
    careerGateEl('careerGateScanBad').hidden = false;
    careerGateEl('careerGateScanBadText').textContent = (opts && opts.reason) || 'This file doesn’t look like a CV.';
    careerGateEl('careerGateScanBadHint').textContent = (opts && typeof opts.attemptsRemaining === 'number') ? ('Please upload your actual CV. ' + opts.attemptsRemaining + ' checks remaining today.') : 'Please upload your actual CV.';
  }
}
function careerGateSyncCta() {
  var cta = careerGateEl('careerGateCta');
  if (!cta) return;
  cta.disabled = !careerGateState.cvVerified;
  cta.textContent = careerGateState.cvVerified ? 'Start browsing careers' : 'Upload your CV to continue';
  cta.classList.toggle('is-enabled', careerGateState.cvVerified);
}
function careerGateReadFile(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function careerGateUpload(kind, file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    if (kind === 'cv') careerGateSetScanState('bad', { reason: 'That file is over 3 MB — please save a smaller PDF and try again.' });
    else careerGateEl('careerGateClHint').textContent = 'That file is over 3 MB — please choose a smaller file.';
    return;
  }
  var base64 = await careerGateReadFile(file);
  var endpoint = kind === 'cv' ? '/api/career/profile/cv' : '/api/career/profile/cover-letter';
  if (kind === 'cv') careerGateSetScanState('checking');
  var res, data;
  try {
    res = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: file.name, fileBase64: base64, mimeType: file.type || '', fileSize: file.size }) });
    data = await res.json().catch(function () { return {}; });
  } catch (err) { data = {}; }
  if (kind === 'cv') {
    if (res && res.ok && data.verified) { careerGateState.cvVerified = true; careerGateSetScanState('ok', { fileName: data.fileName }); }
    else if (res && res.status === 429) careerGateSetScanState('bad', { reason: data.message || 'You’ve reached today’s CV check limit — please try again tomorrow.' });
    else careerGateSetScanState('bad', { reason: data.reason || data.message || 'We couldn’t check that file — please try again.', attemptsRemaining: data.attemptsRemaining });
    careerGateSyncCta();
  } else {
    careerGateEl('careerGateClHint').textContent = (res && res.ok) ? ('Added ✓ ' + file.name) : (data.message || 'Upload failed — please try again.');
  }
}
async function ensureCareerGate() {
  if (careerGateState.checked) return;
  if (shouldLockCareerToSecuredView()) return; // placed GPs never see the gate
  try {
    var res = await fetch('/api/career/profile/status', { credentials: 'same-origin' });
    if (!res.ok) return;
    var data = await res.json();
    careerGateState.checked = true;
    if (data && data.cv) { careerGateState.cvVerified = true; return; }
    careerGateSyncCta();
    openCareerGateModal();
  } catch (err) { /* network failure: don't lock the page */ }
}
document.addEventListener('change', function (ev) {
  if (ev.target && ev.target.id === 'careerGateCvInput') careerGateUpload('cv', ev.target.files && ev.target.files[0]);
  if (ev.target && ev.target.id === 'careerGateClInput') careerGateUpload('cover', ev.target.files && ev.target.files[0]);
});
document.addEventListener('click', function (ev) {
  if (ev.target && ev.target.id === 'careerGateCta' && !ev.target.disabled) closeCareerGateModal();
});
```

Wire-in points:
1. In the `init()` IIFE, after `await loadRemoteApplications({ render: false });` and the following `renderPage()`, add `ensureCareerGate();` (fire-and-forget — must not block page render).
2. In `applyForRole`'s `requiresCv` branch (career.html:10224): replace the redirect-to-my-documents with `careerGateState.cvVerified = false; careerGateState.checked = false; openCareerGateModal();` and keep a toast "Please add your CV first".

- [ ] **Step 4: Bump cache busters** on career.html's own script/style include lines it changes (`?v=20260707a`) — only lines actually relevant (inline script needs no buster; check `js/` includes touched: none expected, so bump only if a shared JS file changed).

- [ ] **Step 5: Verify by hand** — `node --check server.js` (unchanged, still must pass), then run the dev server if available (`npm start` with local JSON DB) and load `/pages/career.html` as a non-placed dev user: gate appears, CV upload cycles through checking→verified (AI unconfigured locally → accepted with warning), CTA enables, modal closes, jobs browse works. If no local runtime is available, state that explicitly in the task report — do not claim browser verification.

- [ ] **Step 6: Commit**

```bash
git add pages/career.html
git commit -m "feat(career): profile-completion gate modal — verified CV required, gold cover-letter booster"
git push
```

---

### Task 6: Submit-to-practice email rebuild (TDD)

**Files:**
- Modify: `server.js` — in-app branch of `POST /api/admin/career/application/submit-to-practice` (attachment block ~30439-30455; body composition ~30500-30530; row PATCH ~30531-30546); new helpers near `buildCareerEmailHtml` (22847)
- Test: `tests/practice-submission-email.test.js`

**Interfaces:**
- Consumes: `buildCandidateIntro` (Task 2), `getCareerProfileDocument` (Task 3), decision columns (Task 1), `ANTHROPIC_MESSAGES_URL`, `RESEND_API_URL`.
- Produces (used by Tasks 7-8):
  - `gp_applications.practice_action_token` set (crypto-random, 24 bytes base64url) before the email sends; `ai_recommendation` cached on the row.
  - Decision URLs: `${APP_BASE_URL}/pages/practice-decision.html?token=<tok>&action=approve` and `...&action=turn_down`.
  - Helper `buildCandidateSubmissionEmailHtml({ gpName, roleTitle, practiceName, intro, recommendation, approveUrl, turnDownUrl, hasCoverLetter })` → email-safe HTML string; exposed on `__testUtils` for unit assertions.
  - Helper `generateCandidateRecommendation({ buffer, mimeType, fileName, gpName })` → `Promise<string>` ('' on any failure).

- [ ] **Step 1: Write failing tests** — same emulator scaffold as Task 3 (copy it; add a Resend capture server whose port feeds `process.env.RESEND_API_URL`, plus `RESEND_API_KEY='test-resend'`). Seed: one GP (`user_profiles` + `user_state` with `gp_onboarding: { country:'uk', targetDate:'2026-11' }`), a `career_roles` row with `source_payload.practice_contact_email`, a `gp_applications` row (`status:'applied'`, `practice_submission_status:'pending_va_submission'`), a **rejected** legacy doc (`document_key:'cv_signed_dated', status:'rejected', file_name:'contract.pdf', updated_at:'2026-07-01'`) and an **uploaded** career CV (`document_key:'career_cv', status:'uploaded', file_name:'Smith-Miller-CV.pdf', updated_at:'2026-06-01'`) — note the rejected doc is NEWER, proving selection is by key+status, not recency. Anthropic emulator returns for the recommendation prompt a fixed 3-sentence string. Admin auth: mirror how existing admin-endpoint tests build the `gp_admin_session` cookie (grep `gp_admin_session` in tests/ and copy; e.g. from an `ats-*.test.js`).

Assertions:

```js
it('attaches the verified career CV, never the rejected registration doc', async () => {
  const res = await httpReq('POST', '/api/admin/career/application/submit-to-practice', { cookie: adminCookie(), body: { applicationId: APP_ID } });
  expect(res.status).toBe(200);
  const sent = resendCaptured[0]; // capture server stores parsed JSON bodies
  const names = (sent.attachments || []).map((a) => a.filename);
  expect(names).toContain('Smith-Miller-CV.pdf');
  expect(names.join()).not.toContain('contract');
});
it('includes intro sentences, AI recommendation, and decision buttons', async () => {
  const sent = resendCaptured[0];
  expect(sent.html).toContain('Expedited Specialist Pathway');
  expect(sent.html).toContain('November 2026');
  expect(sent.html).toContain('Why we recommend');
  expect(sent.html).toContain('/pages/practice-decision.html?token=');
  expect(sent.html).toContain('action=approve');
  expect(sent.html).toContain('action=turn_down');
});
it('persists the action token + AI recommendation on the application row', async () => {
  const row = db.gp_applications.find((a) => a.id === APP_ID);
  expect(String(row.practice_action_token || '').length).toBeGreaterThan(20);
  expect(row.ai_recommendation).toMatch(/\S/);
  const sent = resendCaptured[0];
  expect(sent.html).toContain(row.practice_action_token);
});
it('attaches the cover letter when present', async () => { /* seed career_cover_letter for a 2nd application+GP, resubmit, assert 2 attachments */ });
it('sends without recommendation when AI unavailable', async () => { /* aiMode='error' → 500 from emulator; email still sends; html omits "Why we recommend" */ });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/practice-submission-email.test.js` → FAIL (old attachment picked / no token / no buttons).

- [ ] **Step 3: Implement.**

3a. `generateCandidateRecommendation` (near `buildCareerEmailHtml`):

```js
// 3-sentence, highly-recommending summary of the GP's experience, written by
// AI from the verified careers CV. Returns '' on ANY failure — the email
// simply omits the recommendation block.
async function generateCandidateRecommendation({ buffer, mimeType, fileName, gpName }) {
  try {
    if (!process.env.ANTHROPIC_API_KEY || !(await checkAnthropicBudget())) return '';
    var mime = String(mimeType || '').toLowerCase();
    var blocks = [];
    if (mime === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
    else if (/^image\//.test(mime)) blocks.push({ type: 'image', source: { type: 'base64', media_type: mime === 'image/jpg' ? 'image/jpeg' : mime, data: buffer.toString('base64') } });
    else if (mime.includes('wordprocessingml')) {
      var text = await extractDocxTextWithMammoth(buffer);
      if (!text) return '';
      blocks.push({ type: 'text', text: 'CV TEXT:\n\n' + text.slice(0, 30000) });
    } else return '';
    blocks.push({ type: 'text', text: 'You are writing on behalf of GP Link, a medical recruitment agency, to a practice manager. Based ONLY on the CV above, write EXACTLY three sentences summarising Dr ' + String(gpName || '').trim() + '\'s experience and strengths, framed as a strong recommendation. Mention years of experience and standout clinical/leadership strengths if the CV shows them. Do not invent facts. Plain professional English, no bullet points, no preamble — respond with the three sentences only.' });
    var resp = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 400, messages: [{ role: 'user', content: blocks }] })
    });
    if (!resp.ok) return '';
    var json = await resp.json();
    if (json && json.usage) recordAnthropicSpend(json.usage.input_tokens, json.usage.output_tokens, json.usage.cache_read_input_tokens, json.usage.cache_creation_input_tokens);
    var out = (json && json.content && json.content[0] && json.content[0].text || '').trim();
    return out.length > 20 && out.length < 1200 ? out : '';
  } catch (err) {
    console.warn('[submit-to-practice] recommendation generation failed (email sends without it):', err && err.message);
    return '';
  }
}
```

3b. `buildCandidateSubmissionEmailHtml` (near `buildCareerEmailHtml`; email-safe inline styles; structure follows mockup Section 2):

```js
function buildCandidateSubmissionEmailHtml({ gpName, roleTitle, practiceName, intro, recommendation, approveUrl, turnDownUrl, hasCoverLetter }) {
  var esc = escapeHtml; // reuse the existing escapeHtml helper (grep for it; it exists for email building)
  var displayName = /^dr\b/i.test(String(gpName || '')) ? gpName : 'Dr ' + gpName;
  var factsHtml = (intro.facts || []).map(function (f) {
    return '<span style="display:inline-block;background:#ffffff;border:1px solid #d6e2fb;color:#173da6;font-size:12.5px;font-weight:600;padding:6px 12px;border-radius:999px;margin:4px 6px 0 0">' + esc(f.icon + ' ' + f.label) + '</span>';
  }).join('');
  var recHtml = recommendation ? (
    '<div style="border-left:4px solid #2563eb;background:#eff4ff;border-radius:0 16px 16px 0;padding:16px 20px;margin:20px 0">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#173da6;margin-bottom:8px">⭐ Why we recommend ' + esc(displayName) + '</div>' +
    '<p style="font-size:14.5px;color:#22376b;font-style:italic;margin:0">&ldquo;' + esc(recommendation) + '&rdquo;</p></div>'
  ) : '';
  return (
    '<p style="font-size:14.5px;color:#1f2b43;margin:0 0 14px">Dear ' + esc(practiceName || 'team') + ',</p>' +
    '<p style="font-size:14.5px;color:#1f2b43;margin:0 0 14px">We&rsquo;re delighted to introduce <b>' + esc(displayName) + '</b> for your <b>' + esc(roleTitle || 'GP') + '</b> position.</p>' +
    '<div style="border:1px solid #e3e9f4;border-radius:16px;padding:18px 20px;margin:18px 0;background:#f8fafd">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#173da6;margin-bottom:8px">About ' + esc(displayName) + '</div>' +
    '<p style="font-size:14.5px;color:#1f2b43;margin:0">' + esc(intro.paragraph) + '</p>' +
    '<div style="margin-top:10px">' + factsHtml + '</div></div>' +
    recHtml +
    '<p style="font-size:13px;color:#64748b;margin:16px 0 4px">' + (hasCoverLetter ? 'Their CV and cover letter are attached.' : 'Their CV is attached.') + '</p>' +
    '<div style="text-align:center;margin:28px 0 6px">' +
    '<a href="' + approveUrl + '" style="display:inline-block;padding:15px 44px;background:#16a34a;color:#ffffff;font-weight:700;font-size:16px;text-decoration:none;border-radius:14px">Approve ' + esc(displayName) + '<br><span style="font-size:11.5px;font-weight:500;opacity:.9">and choose interview times</span></a><br>' +
    '<a href="' + turnDownUrl + '" style="display:inline-block;margin-top:12px;font-size:12px;color:#a5b0c2;text-decoration:underline">Turn down this candidate</a></div>' +
    '<p style="font-size:12px;color:#64748b;text-align:center;margin:16px 0 0;border-top:1px solid #e3e9f4;padding-top:14px">Approving opens a page where you pick interview times that suit you &mdash; ' + esc(displayName) + ' then confirms one. Questions? Just reply to this email.</p>'
  );
}
```

(If `escapeHtml` doesn't exist by that name, grep for the existing HTML-escaper used in email builders — e.g. `escapeHtml`, `htmlEscape`, `escAttr` — and use that; do not write a new one.)

3c. Rewire the in-app branch:
- **Attachments** (replace 30439-30455): `const cvRow = await getCareerProfileDocument(inAppGpUserId, 'career_cv');` → if null, legacy fallback: same `user_documents` query as before **plus `&status=eq.uploaded`**. Download via `supabaseStorageDownloadObject(row.storage_bucket || SUPABASE_DOCUMENT_BUCKET, row.storage_path || row.file_url)` as today. Then `const clRow = await getCareerProfileDocument(inAppGpUserId, 'career_cover_letter');` → optional second attachment `{ filename: clRow.file_name || (gpName + '-Cover-Letter.pdf'), content, contentType }`. Keep today's "send without attachment on failure" behavior.
- **Token**: before composing the email: `let actionToken = inAppApplicationRow.practice_action_token; if (!actionToken) { actionToken = crypto.randomBytes(24).toString('base64url'); }` (persist in the PATCH below).
- **Intro**: load profile + onboarding exactly like the existing intro code near 30432 does (`_parseStateVal(inAppStateVal.gp_onboarding)`); call `careerIntro.buildCandidateIntro({ gpName, countryCode: prof.registration_country || ob.country, accountStatus: prof.account_status || inAppStateVal.account_status, specialty: atsSpecialtyFromOnboarding(ob), targetDate: prof.target_arrival_date || ob.targetDate, practiceName, roleTitle })` — add `const careerIntro = require('./lib/career-intro.js');` next to the other lib requires at the top of server.js.
- **Recommendation**: after the CV download succeeds: `const recommendation = (await generateCandidateRecommendation({ buffer: cvBuffer, mimeType: cvRow.mime_type || 'application/pdf', fileName: cvRow.file_name, gpName })) || '';`
- **Body**: replace the current `buildCareerEmailHtml` bodyHtml with `buildCareerEmailHtml({ title: 'Candidate introduction: ' + displayName + ' — ' + roleTitle, bodyHtml: buildCandidateSubmissionEmailHtml({...}) })` (no ctaText — buttons are inside bodyHtml). `approveUrl = APP_BASE_URL + '/pages/practice-decision.html?token=' + encodeURIComponent(actionToken) + '&action=approve'`; `turnDownUrl` same with `action=turn_down`.
- **Row PATCH** (30531-30546): add `practice_action_token: actionToken, ai_recommendation: recommendation || null` to the existing patch body.
- **`__testUtils`**: find where server.js builds `__testUtils` (grep `__testUtils`) and add `buildCandidateSubmissionEmailHtml, generateCandidateRecommendation, buildCandidateIntro: careerIntro.buildCandidateIntro`.

- [ ] **Step 4: Run** — `npx vitest run tests/practice-submission-email.test.js` → PASS; `node --check server.js`.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/practice-submission-email.test.js
git commit -m "feat(career): submission email — verified-CV attachments, profile intro, AI recommendation, approve/turn-down buttons"
git push
```

---

### Task 7: Practice decision + availability endpoints (TDD)

**Files:**
- Modify: `server.js` — new public routes (place near the other public token routes, e.g. next to `/api/practice-intake/sign` ~26898)
- Test: `tests/practice-decision.test.js`

**Interfaces:**
- Consumes: `practice_action_token` (Task 6), `interviewMeetings.buildInterviewRow` (lib/interview-meetings.js:29), `atsUpdateApplicationStageRow` (server.js:23336), `checkRateLimitWindow`, `sendEmail`, `buildCareerEmailHtml`.
- Produces (consumed by Task 8):
  - `GET /api/practice/application/decision-context?token=` → `{ ok:true, gpName, roleTitle, practiceName, decision: null|'approved'|'turned_down', availabilitySubmitted: boolean, interviewBooked: boolean }` (no mutation)
  - `POST /api/practice/application/decision` body `{ token, action:'approve'|'turn_down', reason? }` → `{ ok:true, decision }`
  - `POST /api/practice/application/availability` body `{ token, windows:[{date:'YYYY-MM-DD', fromMin:540, toMin:1020}] }` → `{ ok:true, windowsSaved:n }`

All three: per-IP rate limit `checkRateLimitWindow('practice-decision-ip:' + ip, 30, 60*60*1000)` → 429; token lookup `supabaseDbRequest('gp_applications', 'select=*&practice_action_token=eq.' + encodeURIComponent(token) + '&limit=1')` → 404 `{ ok:false, code:'not_found' }` when missing/empty token (never reveal whether a token "almost" matched).

- [ ] **Step 1: Write failing tests** (same scaffold; seed an application WITH `practice_action_token: 'tok-test-abc123'`, its GP, role, and practice contact):

```js
it('GET decision-context returns candidate summary and never mutates', async () => {
  const res = await httpReq('GET', '/api/practice/application/decision-context?token=tok-test-abc123', {});
  expect(res.status).toBe(200);
  expect(res.body.gpName).toMatch(/Gate|Smith/);
  expect(res.body.decision).toBeNull();
  expect(db.gp_applications[0].practice_decision).toBeUndefined();
});
it('404s on a bad token', async () => {
  const res = await httpReq('GET', '/api/practice/application/decision-context?token=nope', {});
  expect(res.status).toBe(404);
});
it('POST approve marks the application and creates the interview row', async () => {
  const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-abc123', action: 'approve' } });
  expect(res.status).toBe(200);
  const row = db.gp_applications[0];
  expect(row.practice_decision).toBe('approved');
  expect(row.status).toBe('interview');
  const interview = db.scheduled_calls.find((r) => r.meeting_kind === 'interview' && String(r.application_id) === String(row.id));
  expect(interview).toBeTruthy();
  expect(interview.practice_availability_status).toBe('requested');
});
it('approve is idempotent', async () => {
  const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-abc123', action: 'approve' } });
  expect(res.status).toBe(200);
  expect(db.scheduled_calls.filter((r) => r.meeting_kind === 'interview').length).toBe(1);
});
it('POST availability stores windows and flips status to received', async () => {
  const res = await httpReq('POST', '/api/practice/application/availability', { body: { token: 'tok-test-abc123', windows: [{ date: '2026-07-20', fromMin: 540, toMin: 1020 }, { date: '2026-07-21', fromMin: 600, toMin: 900 }] } });
  expect(res.status).toBe(200);
  const interview = db.scheduled_calls.find((r) => r.meeting_kind === 'interview');
  expect(interview.practice_availability_status).toBe('received');
  expect(interview.practice_availability_windows).toHaveLength(2);
});
it('rejects malformed windows', async () => {
  const res = await httpReq('POST', '/api/practice/application/availability', { body: { token: 'tok-test-abc123', windows: [{ date: 'not-a-date', fromMin: 900, toMin: 540 }] } });
  expect(res.status).toBe(400);
});
it('POST turn_down records decision + reason on a second application', async () => {
  const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-def456', action: 'turn_down', reason: 'Position filled' } });
  expect(res.status).toBe(200);
  const row = db.gp_applications.find((a) => a.practice_action_token === 'tok-test-def456');
  expect(row.practice_decision).toBe('turned_down');
  expect(row.practice_decision_reason).toBe('Position filled');
});
```

- [ ] **Step 2: Run to verify failure** — 404s on all three routes.

- [ ] **Step 3: Implement the three handlers.**

Shared lookup:

```js
async function findApplicationByActionToken(token) {
  var t = String(token || '').trim();
  if (!t || t.length < 10) return null;
  if (isSupabaseDbConfigured()) {
    var r = await supabaseDbRequest('gp_applications', 'select=*&practice_action_token=eq.' + encodeURIComponent(t) + '&limit=1');
    return (r.ok && Array.isArray(r.data) && r.data[0]) ? r.data[0] : null;
  }
  return (dbState.gpApplications || []).find(function (a) { return a.practice_action_token === t; }) || null;
}
```

(Verify the local-JSON collection name for gp_applications by grepping `dbState.` near the apply endpoint; use the same.)

- **decision-context**: rate-limit → `findApplicationByActionToken` → load GP name (`user_profiles` by `user_id` — reuse the profile-fetch idiom from the apply endpoint), role title (`career_roles` by `career_role_id` — mirror how submit-to-practice resolves it), practice name. `availabilitySubmitted` = interview row exists with `practice_availability_status='received'`; `interviewBooked` = interview row `status==='booked'`. Return the JSON above. GET performs no writes.
- **decision**:
  - `action==='approve'`: if `row.practice_decision === 'approved'` → 200 `{ ok:true, decision:'approved', already:true }` (idempotent). Else PATCH `gp_applications` `{ practice_decision:'approved', practice_decision_at: nowIso, status:'interview', updated_at }` + `atsUpdateApplicationStageRow(row.id, 'interview', undefined, 'practice_approve')`. Ensure interview row: query `scheduled_calls` for `meeting_kind=eq.interview&application_id=eq.<id>`; if none, insert `interviewMeetings.buildInterviewRow({ applicationId: row.id, userId: row.user_id, careerRoleId: row.career_role_id, practiceName, createdBy: 'practice_decision' })` (mirror exactly how the GP slots endpoint at server.js:27769-27819 creates the row — including any case_id resolution it does — but keep `practice_availability_status: 'requested'`, NOT defaulted, because the practice is about to give its times). Notify: (a) GP email via `sendEmail` + `buildCareerEmailHtml({ title: practiceName + ' would like to interview you!', body: 'Great news — ' + practiceName + ' has approved your application for ' + roleTitle + '. As soon as they confirm their available times you\'ll be able to pick your interview slot in the app.', ctaText: 'View my application', ctaUrl: APP_BASE_URL + '/pages/career.html#applications' })`; (b) ops email to `REGISTRATION_HUB_EMAIL || 'hello@mygplink.com.au'` "Practice approved <GP> — awaiting their interview times". Both best-effort (`.catch(console.warn)` — must not fail the request).
  - `action==='turn_down'`: PATCH `{ practice_decision:'turned_down', practice_decision_at, practice_decision_reason: String(reason||'').slice(0,500) || null, updated_at }`. Do NOT change `status`/`ats_stage` (no 'rejected' stage exists in `ATS_STAGES` — ['applied','submitted','reviewing','interview','offer','hired']); instead email ops: subject "Practice turned down <GP> for <role>" body includes reason — the team follows up with the GP personally (kinder than an automated rejection email).
- **availability**: rate-limit → token lookup → require `row.practice_decision === 'approved'` else 409 `{ ok:false, code:'not_approved' }` → validate windows: array 1..10; each `date` matches `/^\d{4}-\d{2}-\d{2}$/` and parses to a real future-or-today date within 60 days; `Number.isInteger(fromMin) && Number.isInteger(toMin) && fromMin >= 0 && toMin > fromMin && toMin <= 1560`; else 400 with a plain message. Find the interview row (must exist after approve; if missing, create as in approve). PATCH it `{ practice_availability_windows: windows, practice_availability_status: 'received', practice_availability_received_at: nowIso, updated_at: nowIso }` (exact same patch shape as `ingestPracticeAvailabilityReply`, server.js:48762-48770). Notify the GP (mirror the notify block in `ingestPracticeAvailabilityReply` step 4 — email + push "interview times are ready, pick your slot") best-effort.

- [ ] **Step 4: Run** — `npx vitest run tests/practice-decision.test.js` → PASS; `node --check server.js`; full quick pass `npx vitest run tests/career-profile-gate.test.js tests/practice-submission-email.test.js tests/practice-decision.test.js`.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/practice-decision.test.js
git commit -m "feat(career): token-authenticated practice approve/turn-down + availability endpoints feeding interview scheduler"
git push
```

---

### Task 8: `pages/practice-decision.html` — public decision landing page

**Files:**
- Create: `pages/practice-decision.html`
- Modify: `server.js` ONLY IF public pages need route registration (check how `pages/practice-intake.html` is served — grep `practice-intake` in server.js; mirror whatever static-serving/auth exemption it has, e.g. an entry in any public-page allowlist)

**Interfaces:**
- Consumes: the three Task-7 endpoints; `css/gp-tokens.css`.
- Produces: the page linked from the email buttons.

**Visual:** blue GP Link branding per mockup Section 2/3 tone; mobile-first (practice managers open email on phones). NO auth-guard script include (public page, token in URL).

- [ ] **Step 1: Build the page.** Single HTML file, structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Candidate decision — GP Link</title>
  <link rel="stylesheet" href="/css/gp-tokens.css?v=20260707a">
  <style>/* card layout using gp-tokens vars; states: loading, approve-confirm, availability, turndown-confirm, done, error */</style>
</head>
<body>
  <main class="pd-shell">
    <header class="pd-brand">GP Link <span>Candidate decision</span></header>
    <section id="pdLoading">Loading…</section>
    <section id="pdError" hidden><!-- friendly invalid/expired-link message + hello@ contact --></section>
    <section id="pdApprove" hidden>
      <h1>Approve <span data-pd="gpName"></span>?</h1>
      <p>For your <b data-pd="roleTitle"></b> position. Approving lets you choose interview times right away.</p>
      <button id="pdApproveBtn" class="pd-btn-green">Approve &amp; choose interview times</button>
    </section>
    <section id="pdAvailability" hidden>
      <h1>When suits you for an interview?</h1>
      <p>Add a few times that work for your practice — <span data-pd="gpName"></span> will confirm one. Times are in your local timezone.</p>
      <div id="pdWindowRows"></div>
      <button id="pdAddWindow" class="pd-btn-ghost">+ Add another time</button>
      <button id="pdSubmitWindows" class="pd-btn-green">Send interview times</button>
    </section>
    <section id="pdTurnDown" hidden>
      <h1>Turn down <span data-pd="gpName"></span>?</h1>
      <textarea id="pdReason" placeholder="Optional — a short reason helps us find you a better fit"></textarea>
      <button id="pdTurnDownBtn" class="pd-btn-grey">Confirm — turn down this candidate</button>
      <a href="#" id="pdKeep" class="pd-link">Actually, I'd like to approve instead</a>
    </section>
    <section id="pdDone" hidden><!-- success copy set by JS per flow --></section>
  </main>
  <script>/* inline app logic below */</script>
</body>
</html>
```

JS behavior (inline):
- Parse `token` + `action` from `location.search`. `GET /api/practice/application/decision-context?token=...`; on 404 show `#pdError`.
- Context routing: if `decision === 'turned_down'` → done state "You've turned down this candidate — thanks for letting us know." If `interviewBooked` → done "Interview booked — check your calendar invitation." If `decision === 'approved' && !availabilitySubmitted` → straight to `#pdAvailability`. If `availabilitySubmitted` → done "Times received — Dr X will confirm shortly." Else `action === 'turn_down'` → `#pdTurnDown`, otherwise `#pdApprove`.
- Approve click → `POST /api/practice/application/decision {token, action:'approve'}` → show `#pdAvailability`.
- Availability rows: each row = `<input type="date">` + from/to `<select>` of 30-min increments 06:00–22:00 (display "9:00 AM"; value = minutes-from-midnight so `fromMin/toMin` post straight through). Start with 2 rows; `+ Add another time` appends (max 10). Submit → validate client-side (date set, to > from) → `POST /api/practice/application/availability` → done state "Thanks! Dr X will confirm one of your times — you'll get a calendar invitation automatically."
- Turn-down click → POST with reason → done state. `#pdKeep` link switches to the approve flow (re-uses the same context).
- All fetches `credentials:'omit'`; every failure path lands on a friendly retry message with hello@mygplink.com.au fallback.

- [ ] **Step 2: Serving check** — confirm `GET /pages/practice-decision.html` returns the page without auth on the dev server (practice-intake.html precedent: grep how it's exempted from any auth redirects; replicate). If a public-page allowlist exists in server.js or `js/auth-guard.js` route rules, add this page.

- [ ] **Step 3: Manual verify** — with the dev server + a seeded token (insert a local-JSON application with `practice_action_token`), walk approve → availability → submit and turn-down → confirm in a browser. Report honestly if not run.

- [ ] **Step 4: Commit**

```bash
git add pages/practice-decision.html server.js
git commit -m "feat(career): public practice decision page — approve + pick interview times, or turn down"
git push
```

---

### Task 9: Full verification + ship

**Files:**
- Modify: none (verification only) + PR creation

- [ ] **Step 1: Full test suite** — `npx vitest run` (expect ~1600+ tests; baseline on main was 1598 — all pre-existing tests must pass; investigate ANY failure, including ones that look unrelated).
- [ ] **Step 2: `node --check server.js`** and `node --check lib/career-intro.js`.
- [ ] **Step 3: Grep audit** — `grep -n 'cv_signed_dated' server.js` : the ONLY remaining uses must be (a) the legacy fallback inside submit-to-practice (with `status=eq.uploaded`) and (b) unrelated registration-file flows (AHPRA packs etc.) — the careers apply-gate and attachment primary path must reference `career_cv`.
- [ ] **Step 4: Push + draft PR** — `git push`, then `gh pr create --draft` with a plain-English summary (what changed, the Smith Miller bug fix, migration to apply, what still needs owner action: applying the migration + a live end-to-end email test).
- [ ] **Step 5: Apply the migration to production Supabase** via the established `exec_sql` RPC pattern (service key in the MAIN checkout's `.env`, NOT the worktree; helper pattern in memory `supabase-migrations-exec-sql`: param name is `query`, schema-qualify). It is additive (nullable columns + partial index) and safe to apply before merge. Verify with a `select column_name from information_schema.columns where table_name='gp_applications'` check. If the key can't be read, note it in the PR instead — do not guess.

---

## Self-Review Notes (already applied)

- Spec coverage: gate popup w/ mandatory CV + optional cover letter + 150% gold booster (T5), AI genuine-CV scan (T3), rate limiting (T3 per-user daily + T7 per-IP), attachment bug fix incl. legacy status filter (T6), pathway/country/start-date summary from onboarding (T2+T6), 3-sentence AI recommendation (T6), Approve + small grey Turn Down buttons (T6), approve → interview scheduling flow (T7+T8), GP notified to book via existing flow (T7).
- Type consistency: `getCareerProfileDocument(userId, key)` used in T3/T4/T6; window shape `{date, fromMin, toMin}` matches `lib/interview-scheduler.js` overrides consumption (`o.date`, `o.fromMin`, `o.toMin`); token column name `practice_action_token` consistent across T1/T6/T7/T8.
- Known verification points for implementers (line numbers may drift): `checkRateLimitWindow` return shape, `escapeHtml` helper name, `dbState` collection names, `__testUtils` assembly point, admin-cookie test idiom, practice-intake public-page serving. Each is called out inline where used.
