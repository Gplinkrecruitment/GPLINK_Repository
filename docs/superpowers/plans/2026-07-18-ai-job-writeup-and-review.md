# AI Job Write-up + Combined Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** AI writes an identity-masked, grounded job write-up from the practice's form + website + area knowledge; the CEO reviews all details, edits, previews (app + website), and approves — on one screen.

**Architecture:** Pure prompt/parse/mask logic in `lib/job-writeup.js` (unit-tested, no network). One admin endpoint generates + stores the write-up (`source_payload.gpLink.aiWriteup`) lazily. Both job pages render it with a fallback. The review UI reuses the existing editor modal. A preview flag renders pending jobs to admins only.

**Tech Stack:** Vanilla JS/HTML, Node `server.js`, Supabase, vitest.

## Global Constraints

- **Node not on PATH.** First: `export PATH="/Users/gplinkrecruitment/.claude/jobs/2afa6df4/tmp/node-v20.18.1-darwin-arm64/bin:$PATH"` → `node --version` = v20.18.1.
- **CommonJS.** Test files must **not** `require('vitest')` (`globals:true`).
- **`node --check server.js` before every commit** — it runs the whole product.
- **Baseline is not green:** pristine branch = **3 failed / 3078 passed**. Same 3 files fail on `origin/main` (`eligibility-waitlist`, `onboarding-review-roundtrip`, `practice-status-page`). Judge regressions against **3 failed**, never zero. Above 3 = you broke something; fix your code, not the test.
- **IDENTITY MASKING IS NON-NEGOTIABLE.** The AI write-up, and everything derived from it, must contain **no practice name, no doctor name, no street address**. The public website has no session and must never receive them. Every task that produces or renders write-up text enforces this.
- **Anthropic call pattern** (copy exactly): `fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01', 'Content-Type':'application/json' }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 900, temperature: 0, messages:[{role:'user', content: prompt}] }) })`, then `data.content[0].text`, extract `/\{[\s\S]*\}/`, `JSON.parse`. Call `recordAnthropicSpend(...)` if `data.usage`. Use a 30s AbortController timeout.
- **No `ANTHROPIC_API_KEY` locally** — the real call cannot run here. Every AI path must degrade gracefully (return a reason, never throw) and be tested with a mocked `fetch`.
- Cache-buster on changed JS/HTML tags: `?v=20260718a`.
- Plain English in all practice/CEO-facing copy. Commit after each task. Do NOT push (the controller ships).

---

### Task 1: `lib/job-writeup.js` — pure logic (prompt, parse, identity-mask backstop)

**Files:** Create `lib/job-writeup.js`; Test `tests/job-writeup.test.js`.

**Interfaces — Produces:**
- `buildWriteupPrompt({ details, introText, websiteText, suburb, nearestCity, state }) → string`
- `parseWriteupResponse(rawModelText) → { about, highlights: string[], sources: string[] } | null` (null on unparseable)
- `maskIdentity(text, { practiceName, address }) → string` — strips the practice name, any street address, and obvious doctor-name patterns ("Dr Smith")
- `scrubWriteup(writeup, { practiceName, address }) → writeup` — applies `maskIdentity` to `about` and every `highlights[]`
- `WRITEUP_SOURCES = ['form','website','area']`

- [ ] **Step 1: Write the failing test** — `tests/job-writeup.test.js`:

```js
const { buildWriteupPrompt, parseWriteupResponse, maskIdentity, scrubWriteup } = require('../lib/job-writeup');

describe('buildWriteupPrompt', () => {
  it('forbids naming the practice, doctors, or street in the prompt', () => {
    const p = buildWriteupPrompt({ details: { percentage_split: '70' }, introText: 'nice area', websiteText: 'skin clinic', suburb: 'Erina', state: 'NSW' });
    expect(p).toMatch(/do not (name|mention|include)[^.]*practice/i);
    expect(p).toMatch(/JSON/);
    expect(p).toContain('Erina');
    expect(p).toContain('skin clinic'); // website text is fed in
  });
  it('omits the website section when no website text is available', () => {
    const p = buildWriteupPrompt({ details: {}, introText: 'x', websiteText: '', suburb: 'Erina', state: 'NSW' });
    expect(p).not.toMatch(/website says|from their website/i);
  });
});

describe('parseWriteupResponse', () => {
  it('parses a well-formed JSON block even with prose around it', () => {
    const raw = 'Here you go:\n{"about":"An established practice on the Central Coast.","highlights":["DPA location","On-site nursing"],"sources":["form","area"]}\nHope that helps';
    expect(parseWriteupResponse(raw)).toMatchObject({ about: 'An established practice on the Central Coast.', highlights: ['DPA location','On-site nursing'], sources: ['form','area'] });
  });
  it('returns null on junk', () => { expect(parseWriteupResponse('no json here')).toBeNull(); expect(parseWriteupResponse('')).toBeNull(); });
  it('coerces a missing highlights/sources to arrays', () => {
    expect(parseWriteupResponse('{"about":"x"}')).toMatchObject({ about: 'x', highlights: [], sources: [] });
  });
});

describe('maskIdentity — the safety backstop', () => {
  it('removes the practice name wherever it appears', () => {
    expect(maskIdentity('Erina Medical Centre is a great place; join Erina Medical Centre.', { practiceName: 'Erina Medical Centre' }))
      .not.toMatch(/Erina Medical Centre/);
  });
  it('removes a street address', () => {
    expect(maskIdentity('Located at 60A Erina Valley Rd, come visit.', { address: '60A Erina Valley Rd, Erina NSW 2250' }))
      .not.toMatch(/60A Erina Valley Rd/);
  });
  it('removes doctor names like "Dr Smith"', () => {
    expect(maskIdentity('Led by Dr Jane Smith and Dr Patel.', {})).not.toMatch(/Dr Jane Smith|Dr Patel/);
  });
  it('leaves ordinary text alone', () => {
    expect(maskIdentity('An established practice on the NSW Central Coast.', { practiceName: 'Erina Medical Centre' }))
      .toBe('An established practice on the NSW Central Coast.');
  });
});

describe('scrubWriteup', () => {
  it('scrubs about and every highlight', () => {
    const w = scrubWriteup({ about: 'Erina Medical Centre rocks', highlights: ['Join Erina Medical Centre','DPA location'], sources: ['form'] }, { practiceName: 'Erina Medical Centre' });
    expect(w.about).not.toMatch(/Erina Medical Centre/);
    expect(w.highlights[0]).not.toMatch(/Erina Medical Centre/);
    expect(w.highlights[1]).toBe('DPA location');
  });
  it('never throws on empty input', () => { expect(() => scrubWriteup({ about:'', highlights: [] }, {})).not.toThrow(); });
});
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/job-writeup.test.js`).
- [ ] **Step 3: Implement `lib/job-writeup.js`.** Key points:
  - `buildWriteupPrompt` returns a prompt that: states the role of a recruitment copywriter; lists the allowed facts (the details k/v, the raw intro, the website text if any, the suburb/region for area knowledge); **explicitly forbids** naming the practice, any doctor, or the street; forbids invented clinical services or superlatives; asks for `{"about": "...", "highlights": ["..."], "sources": ["form"|"website"|"area"]}` JSON only; caps `about` to ~3 short paragraphs and `highlights` to 5.
  - `parseWriteupResponse`: extract first `/\{[\s\S]*\}/`, `JSON.parse` in try/catch → null; coerce `highlights`/`sources` to arrays; require a non-empty string `about` else null.
  - `maskIdentity`: escape+replace the `practiceName` (global, case-insensitive) with "the practice"; replace the street portion of `address` (take the part before the first comma) with "" ; regex-strip `/\bDr\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g` → "our doctors"; collapse double spaces. Guard all inputs (null-safe).
  - `scrubWriteup`: map `maskIdentity` over `about` + each `highlights` entry; keep `sources`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(writeup): pure job-writeup logic — prompt, parse, identity-mask backstop`.

---

### Task 2: The generation endpoint + website fetch + Anthropic call

**Files:** Modify `server.js` (new route near the other `/api/ats/job*` routes; a `fetchWebsiteText` helper; a `generateJobWriteup` helper). Test `tests/job-writeup-endpoint.test.js` (follow `tests/ats-endpoints.test.js` seeding + `globalThis.fetch` mock).

**Interfaces — Consumes:** Task 1's `buildWriteupPrompt`/`parseWriteupResponse`/`scrubWriteup`. **Produces:** `POST /api/ats/job/ai-writeup?id=<jobId>` (admin, `requireAtsSession`) → `{ ok:true, writeup }` or `{ ok:false, reason }`; stores `source_payload.gpLink.aiWriteup = { about, highlights, sources, generatedAt }`.

- [ ] **Step 1: Write failing tests** covering: (a) happy path — mock website fetch returns HTML, mock Anthropic returns JSON write-up; assert the stored job gets `source_payload.gpLink.aiWriteup` with masked `about`; (b) **no key** → `{ ok:false, reason:'ai_unavailable' }`, no throw; (c) **website fetch fails** → still succeeds using form+area, `sources` has no `website`; (d) requires an admin session (401/403/302 without cookie). Use the existing `beforeAll` seeding of `jp1` (pending). Mock `globalThis.fetch`: branch on URL — `api.anthropic.com` → the write-up JSON; the practice website host → HTML; else real fetch.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
  - `async function fetchWebsiteText(url)`: only `http(s)`; `AbortController` 10s; `fetch`; if `!res.ok` return ''; read text; strip `<script>/<style>`, tags → spaces, collapse whitespace; return first ~4000 chars. Any throw → return '' (non-fatal).
  - `async function generateJobWriteup(job)`: gather `details` + `intro_text` (from `source_payload.practice_intro.text` or `details`/`summary`) + `suburb`/`nearest_city`/`location_state`; `websiteText = details.website ? await fetchWebsiteText(details.website) : ''`; if `!process.env.ANTHROPIC_API_KEY` return `{ ok:false, reason:'ai_unavailable' }`; build prompt; call Anthropic (pattern above); `parseWriteupResponse`; if null return `{ ok:false, reason:'ai_parse_failed' }`; `scrubWriteup(writeup, { practiceName: job.practice_name, address: job.address })`; set `sources` to include `website` only if `websiteText` was non-empty; return `{ ok:true, writeup: { ...scrubbed, generatedAt: <iso> } }`.
  - Route `POST /api/ats/job/ai-writeup`: `requireAtsSession`; load job via `atsGetJobRow(id)`; `generateJobWriteup`; on `ok`, merge into `source_payload.gpLink.aiWriteup` and persist (patch `source_payload`); return `{ ok, writeup }` / `{ ok:false, reason }`.
- [ ] **Step 4:** `node --check server.js` + run the new test file + full suite (report vs 3-failed baseline).
- [ ] **Step 5: Commit** `feat(writeup): admin endpoint generates + stores the AI write-up (graceful, masked)`.

---

### Task 3: Render the write-up on both job pages (with fallback + masking assertions)

**Files:** Modify `server.js` shaping (`buildCareerRoleGpLinkMetaFromRow` ~`:16699`, in-app payload ~`:18615`, public payload/`PUBLIC_JOB_FIELDS`), `pages/job.html` (about ~`:1842`, benefits `buildBenefitsHtml`), `pages/site-job.html` (about section). Test `tests/job-writeup-render.test.js`.

**Interfaces — Consumes:** `source_payload.gpLink.aiWriteup`. **Produces:** shaped job payload carries `aiAbout` (string) + `aiHighlights` (string[]) — masked-safe, name-free.

- [ ] **Step 1: Write failing tests** — shaped in-app + public payloads expose `aiAbout`/`aiHighlights` when the row has `aiWriteup`; fall back to `intro_text`/benefits when absent; **the public payload contains no practice name** even if `aiWriteup.about` somehow did (double-scrub on serve). Both HTML files reference `aiAbout`/`aiHighlights`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In the meta builder, read `row.source_payload?.gpLink?.aiWriteup`; expose `aiAbout = scrub(writeup.about)` (re-apply `maskIdentity` on serve as defense-in-depth) and `aiHighlights`. In `job.html`, the About block prefers `role.aiAbout` then `intro_text`; `buildBenefitsHtml` prefers `role.aiHighlights`. Same in `site-job.html`. Bump both files' cache-busters to `?v=20260718a`.
- [ ] **Step 4:** `node --check server.js` + tests + full suite vs baseline.
- [ ] **Step 5: Commit** `feat(writeup): render the AI write-up on the in-app + website listings, name-free`.

---

### Task 4: The combined review screen

**Files:** Modify `js/ceo-ats-jobs.js` (the pending-job click → open review; extend the editor/approval modal), bump its cache-buster in `pages/ceo-dashboard.html`. Test `tests/ceo-ats-review-ui.test.js` (source-level, like `tests/onboarding-review-roundtrip.test.js`).

**Interfaces — Consumes:** `GET /api/ats/job?id=` (`d.editor` has all fields; add `aiWriteup` to that payload in `atsJobEditorPayload`), the Task 2 endpoint, the Task 5 preview URLs.

- [ ] **Step 1: Write failing tests** (assert on `js/ceo-ats-jobs.js` source): a pending job opens the review (not the empty board); the review markup includes the AI write-up textarea, a Regenerate control (`data-ats-regenerate-writeup`), a "show what the practice wrote" toggle, preview links (`data-ats-preview-app` / `data-ats-preview-site`), the suburb-photo uploader, and Approve/Reject. `atsJobEditorPayload` returns `ai_about`/`ai_highlights`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In the list click handler, when the clicked card is `approval_status==='pending'`, open the review view instead of `atsOpenJobBoard`. Build the review by extending the existing editor modal render with: the AI write-up block (about textarea seeded from `editor.ai_about`, highlights, Regenerate button that POSTs to `/api/ats/job/ai-writeup` and re-renders, show-original toggle from `editor.intro_text`), two preview buttons opening the Task 5 URLs in a new tab, and the existing suburb-photo + Approve/Reject controls (reuse `openApprovalModal`'s photo logic). Add `ai_about`/`ai_highlights` to `atsJobEditorPayload`. Bump cache-buster.
- [ ] **Step 4:** `node --check server.js` + tests + full suite.
- [ ] **Step 5: Commit** `feat(review): one combined review screen — details, AI write-up, preview, approve`.

---

### Task 5: Admin-only preview of a pending job

**Files:** Modify `server.js` (the `job.html` + `site-job.html` route handlers and the job-detail data endpoints they call). Test `tests/job-preview-mode.test.js`.

**Interfaces — Produces:** `?preview=1` on the in-app + public job routes renders a job regardless of `is_active`/`approval_status`, **only** for an authenticated ATS/admin session; otherwise the flag is ignored (normal public gating applies).

- [ ] **Step 1: Write failing tests:** with `preview=1` + admin cookie, a pending (`is_active:false`) job's detail resolves (not 404); with `preview=1` and **no** admin session, the pending job still 404s (flag ignored); the previewed payload includes `aiAbout`; a non-preview request for a live job is unchanged.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In the job-detail data path, compute `isAdminPreview = url.searchParams.get('preview') === '1' && !!<valid ATS/admin session>`. When true, look the job up without the `is_active=eq.true` filter and skip the approved/active gate. Everything else (masking, shaping) identical. Never let `preview=1` bypass gating without the session.
- [ ] **Step 4:** `node --check server.js` + tests + full suite.
- [ ] **Step 5: Commit** `feat(preview): admin-only preview of a not-yet-live job (app + website)`.

---

## Shipping

1. Full suite — report real numbers vs the **3-failed** baseline.
2. `node --check server.js`.
3. **Browser click-through** on localhost (real app, local JSON DB, `AUTH_DISABLED`/seeded pending job): open the review, confirm the AI block + previews render. The AI call itself won't run locally (no key) — verify the graceful fallback shows, and rely on the mocked-fetch tests for the AI path. State this plainly.
4. Merge `origin/main`, resolve, re-run suite, push to main.
5. **Owner note:** the AI write-up only produces output in production (key set there). After deploy, regenerating Erina's write-up in the live review is the first real end-to-end AI run — watch it.

## Not in scope
- Rewriting structured fields (title/earnings/split) via AI — those stay as submitted/edited.
- Background/at-sign-time generation — write-up is lazy (on review open / Regenerate).
