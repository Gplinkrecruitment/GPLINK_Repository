# Grounded Suggest-a-Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin "Suggest a reply" produce accurate, grounded drafts an RSO trusts — by feeding the AI a small curated stage playbook + the candidate's real structured facts + the recent thread, kept token-light via prompt caching and a lighter model — and wire it into the new hub Inbox / candidate Emails composer.

**Architecture:** This **evolves the existing** `/api/admin/email-triage/suggest-reply` endpoint (server.js ~30551) rather than building new. Two small pure modules carry the new logic so they're unit-testable: `lib/registration-playbook.js` (curated per-stage guidance, stage-scoped) and `lib/suggest-reply-prompt.js` (assembles the prompt with **static/cacheable content first, dynamic content last**, plus grounding rules). The endpoint reuses the already-cached 24h `ai_handover_summary` for background, keeps the structured facts it already assembles, switches off the deprecated hardcoded model, and keeps prompt caching. The hub composer's existing "Suggest a reply" button calls the endpoint with the conversation's `latestTaskId`.

**Tech Stack:** Node monolith (`server.js`), Anthropic Messages API (prompt caching), vanilla JS (`pages/admin.html`), vitest.

## Global Constraints

- **Draft-only, never auto-sent.** The output fills the reply box for the RSO to edit and send. No code path sends it automatically.
- **Grounded:** the AI must use ONLY facts in the provided context; it must NOT invent document statuses, dates, requirements, or outcomes; when unsure it flags `[RSO: please confirm …]` rather than guessing; it never states a document/step is complete unless the facts say so.
- **Token-light:** the stage playbook is small and **stage-scoped** (only the current stage's section is sent); the cached `ai_handover_summary` is **reused, never recomputed in the request path**; facts go as a compact structured object, not raw screens; the static block (rules + playbook) is cached via `cache_control: {type:'ephemeral'}` and placed **before** the dynamic content.
- **Model:** the suggest-reply call must use a current, non-deprecated model via the new `SUGGEST_REPLY_MODEL` env (default `claude-sonnet-4-6`). Do NOT keep the existing hardcoded `claude-opus-4-20250514` (deprecated) for this endpoint. Do NOT change the other ~14 Anthropic call sites — out of scope (note as a follow-up).
- **Non-destructive:** keep the endpoint's request (`{taskId}`) and response (`{ok, suggestedReply, context}`) shape unchanged so existing callers keep working.
- **Test gate:** `npx vitest run` stays fully green (baseline 624). `node --check server.js` before any server.js commit. Run tests with `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH"; ./node_modules/.bin/vitest run`.
- **Cache-buster:** admin.html script bump uses `?v=YYYYMMDD[letter]`.
- **Branch:** preview only (`worktree-rso-email-hub-prototype`); do not merge until reviewed.

---

### Task 1: Curated per-stage playbook module

**Files:**
- Create: `lib/registration-playbook.js`
- Test: `tests/registration-playbook.test.js`

**Interfaces:**
- Produces: `playbookForStage(stage: string): string` (returns the curated guidance text for that stage, or `''` for unknown), and `STAGE_PLAYBOOK` (the content object).

> **OWNER NOTE for the implementer:** the text below is a *starting* playbook drawn from the registration flow. It is domain content the GP Link owner should review and refine after this ships — keep each section tight (token-light). Do not expand it speculatively.

- [ ] **Step 1: Write the failing test**

```js
// tests/registration-playbook.test.js
import { describe, it, expect } from 'vitest';
import pkg from '../lib/registration-playbook.js';
const { playbookForStage, STAGE_PLAYBOOK } = pkg;

describe('playbookForStage', () => {
  it('returns the AHPRA section for "ahpra"', () => {
    expect(playbookForStage('ahpra').toLowerCase()).toContain('ahpra');
  });
  it('is case-insensitive and trims whitespace', () => {
    expect(playbookForStage('  AHPRA ')).toBe(playbookForStage('ahpra'));
  });
  it('maps the "placement" stage to the same section as "career"', () => {
    expect(playbookForStage('placement')).toBe(playbookForStage('career'));
  });
  it('returns empty string for an unknown stage (no crash)', () => {
    expect(playbookForStage('nonsense')).toBe('');
    expect(playbookForStage(null)).toBe('');
  });
  it('every section is non-empty and reasonably small (<1200 chars)', () => {
    Object.values(STAGE_PLAYBOOK).forEach((v) => {
      expect(v.length).toBeGreaterThan(0);
      expect(v.length).toBeLessThan(1200);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH"; ./node_modules/.bin/vitest run tests/registration-playbook.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```js
// lib/registration-playbook.js
'use strict';

// Curated, per-stage guidance for the AI "Suggest a reply" feature.
// OWNER: review/refine this text — it is the standard guidance an RSO gives at
// each registration stage. Keep each entry tight (token-light).
var STAGE_PLAYBOOK = {
  myintealth:
    'MyIntealth: the doctor sets up their MyIntealth account so AMC/AHPRA steps can begin. ' +
    'They typically need to verify their email and upload a clear copy of their photo ID. ' +
    'Common questions: "what do I upload?" → ID + verify email only at this stage; everything else comes later. ' +
    'Reassure them it is quick and you will guide each next step.',
  amc:
    'AMC: the doctor builds their AMC portfolio / sits the AMC CAT exam. ' +
    'They usually need their passport bio page and a recent passport-style photo to book the exam. ' +
    'Common questions: photo size → standard passport size (35x45mm) from any chemist/post office. ' +
    'Do not promise exam dates or results — defer specifics to the RSO if not in the facts.',
  career:
    'Secured Placement / practice pack: the doctor has (or is securing) a GP placement, and we collect the ' +
    'practice documents: SPPA-00 (Supervised Practice Plan), Section G, Position Description, signed Offer/Contract, ' +
    'and the Supervisor CV. Emails here are often WITH the practice. ' +
    'Common questions: what we still need from the practice → only list documents the facts mark as outstanding.',
  ahpra:
    'AHPRA registration: the doctor lodges their AHPRA application. Typical requirements: certified copies of their ' +
    'medical degree, a signed and dated CV, an English language pathway (a test like IELTS/OET/PLAB/NZREX, or an ' +
    'evidence-based exemption), an international criminal history check (Fit2Work ICHC), and the SPPA-00 supervised ' +
    'practice plan. "Certified copy" = a JP/pharmacist/doctor writes "true copy of the original", signs and dates it. ' +
    'Only say a document is received/approved if the facts say so.',
  pbs:
    'PBS & Medicare: after AHPRA registration, the doctor gets their Medicare provider number and PBS prescriber access. ' +
    'This step depends on AHPRA being granted first. Keep replies high-level and defer exact timing to the RSO.',
  commencement:
    'Commencement: the start date is being confirmed and the first-day pack prepared. ' +
    'Tone is congratulatory and practical. Do not state a confirmed start date unless it appears in the facts.',
};

// Some case stages are aliases of a playbook section.
var STAGE_ALIASES = { placement: 'career', visa: 'ahpra' };

function playbookForStage(stage) {
  var key = String(stage == null ? '' : stage).trim().toLowerCase();
  key = STAGE_ALIASES[key] || key;
  return STAGE_PLAYBOOK[key] || '';
}

module.exports = { STAGE_PLAYBOOK, playbookForStage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/registration-playbook.test.js` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/registration-playbook.js tests/registration-playbook.test.js
git commit -m "feat(suggest): curated stage-scoped registration playbook"
```

---

### Task 2: Grounded prompt-assembly module

**Files:**
- Create: `lib/suggest-reply-prompt.js`
- Test: `tests/suggest-reply-prompt.test.js`

**Interfaces:**
- Consumes: `playbookForStage` (Task 1) is called by the endpoint, not here — this module receives the resolved `playbookText` string.
- Produces:
  - `buildSuggestReplyMessages({ playbookText, handoverSummary, facts, threadText, currentEmail, senderIsGp }): { system: Array, userText: string }`
  - `GROUNDING_RULES: string` (the verbatim grounding instructions).
  - The `system` array is the cacheable static block (rules + playbook) with `cache_control`; `userText` is the dynamic content. The static block MUST NOT contain `currentEmail`/`facts` (so the cache prefix stays stable across different emails).

- [ ] **Step 1: Write the failing test**

```js
// tests/suggest-reply-prompt.test.js
import { describe, it, expect } from 'vitest';
import pkg from '../lib/suggest-reply-prompt.js';
const { buildSuggestReplyMessages, GROUNDING_RULES } = pkg;

const base = {
  playbookText: 'AHPRA: certified copies, signed CV, English pathway, ICHC, SPPA-00.',
  handoverSummary: 'Dr Sana Khan, AHPRA stage, UK. CV rejected once.',
  facts: { stage: 'ahpra', open_tasks: [{ title: 'Upload certified degree', status: 'open' }] },
  threadText: 'You: please send a certified copy.\nSana: where do I get it certified?',
  currentEmail: 'Sana: where do I get my degree certified?',
  senderIsGp: true,
};

describe('buildSuggestReplyMessages', () => {
  it('static system block carries the grounding rules + playbook and is cacheable', () => {
    const { system } = buildSuggestReplyMessages(base);
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0].text).toContain(GROUNDING_RULES);
    expect(system[0].text).toContain('AHPRA: certified copies');
  });
  it('the cacheable static block does NOT contain the per-email content', () => {
    const { system } = buildSuggestReplyMessages(base);
    expect(system[0].text).not.toContain('where do I get my degree certified');
    expect(system[0].text).not.toContain('Upload certified degree'); // facts are dynamic
  });
  it('user text carries summary, facts, thread, and the email to answer', () => {
    const { userText } = buildSuggestReplyMessages(base);
    expect(userText).toContain('Dr Sana Khan');
    expect(userText).toContain('Upload certified degree');
    expect(userText).toContain('where do I get my degree certified');
  });
  it('addresses the doctor directly when senderIsGp is true', () => {
    expect(buildSuggestReplyMessages(base).userText.toLowerCase()).toContain('directly to the doctor');
  });
  it('refers to the doctor in third person when the sender is a practice', () => {
    const { userText } = buildSuggestReplyMessages({ ...base, senderIsGp: false });
    expect(userText.toLowerCase()).toContain('third person');
  });
  it('omits optional sections cleanly when absent', () => {
    const { userText } = buildSuggestReplyMessages({ currentEmail: 'hi', senderIsGp: true });
    expect(userText).toContain('hi');
    expect(userText).not.toContain('CANDIDATE SUMMARY');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/suggest-reply-prompt.test.js` → Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```js
// lib/suggest-reply-prompt.js
'use strict';

var GROUNDING_RULES = [
  'You draft a reply for a GP Link Registration Support Officer to review and send. It is never sent automatically.',
  'Use ONLY the facts provided below. Do not invent document statuses, dates, requirements, or outcomes.',
  'If the answer depends on something not in the context, do not guess — write the reply but flag what the RSO must confirm, e.g. "[RSO: please confirm whether X]".',
  'Never state that a document or step is complete unless the facts explicitly say so.',
  'Use a warm, clear, plain-English tone. Avoid jargon the doctor would not understand.',
].join('\n');

function buildSystemBlocks(playbookText) {
  var text =
    'You are Hazel, a Registration Support Officer at GP Link (helping overseas GPs register to work in Australia).\n\n' +
    GROUNDING_RULES +
    (playbookText ? ('\n\n--- Standard guidance for this stage ---\n' + playbookText) : '');
  return [{ type: 'text', text: text, cache_control: { type: 'ephemeral' } }];
}

function buildUserText(opts) {
  opts = opts || {};
  var parts = [];
  if (opts.handoverSummary) parts.push('CANDIDATE SUMMARY (background, may be up to a day old):\n' + opts.handoverSummary);
  if (opts.facts) parts.push('CURRENT FACTS (authoritative — prefer these over the summary):\n' + JSON.stringify(opts.facts, null, 2));
  if (opts.threadText) parts.push('RECENT EMAILS IN THIS CONVERSATION:\n' + opts.threadText);
  parts.push('THE EMAIL TO REPLY TO:\n' + (opts.currentEmail || ''));
  parts.push(opts.senderIsGp
    ? 'Write a reply addressed directly to the doctor.'
    : 'Write a reply addressed to this person (a medical practice or third party); refer to the doctor in the third person.');
  return parts.join('\n\n');
}

function buildSuggestReplyMessages(opts) {
  opts = opts || {};
  return {
    system: buildSystemBlocks(opts.playbookText || ''),
    userText: buildUserText(opts),
  };
}

module.exports = { GROUNDING_RULES, buildSystemBlocks, buildUserText, buildSuggestReplyMessages };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/suggest-reply-prompt.test.js` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/suggest-reply-prompt.js tests/suggest-reply-prompt.test.js
git commit -m "feat(suggest): grounded prompt assembly (static-first + grounding rules)"
```

---

### Task 3: Evolve the suggest-reply endpoint to use the playbook + summary + lighter model

**Files:**
- Modify: `server.js` — the `/api/admin/email-triage/suggest-reply` handler (~30551–30687); add a `SUGGEST_REPLY_MODEL` const near the other model config (~line 179); add the two `require`s at the top.
- Test: covered by the pure-module tests (Tasks 1–2) + full-suite no-regression + `node --check`.

**Interfaces:**
- Consumes: `registrationPlaybook.playbookForStage` (Task 1), `suggestReplyPrompt.buildSuggestReplyMessages` (Task 2).
- Produces: same endpoint contract — request `{ taskId }`, response `{ ok, suggestedReply, context }`.

- [ ] **Step 1: Add requires + model const**

At the top of `server.js` with the other `require('./lib/...')` lines:
```js
const registrationPlaybook = require('./lib/registration-playbook.js');
const suggestReplyPrompt = require('./lib/suggest-reply-prompt.js');
```
Near the existing `ANTHROPIC_MODEL` const (`grep -n "ANTHROPIC_MODEL =" server.js`, ~line 179) add:
```js
// Suggest-a-reply is a focused drafting task — use a lighter, current model (not the deprecated default).
const SUGGEST_REPLY_MODEL = process.env.SUGGEST_REPLY_MODEL || 'claude-sonnet-4-6';
```

- [ ] **Step 2: Wire the playbook + cached summary + new prompt into the handler**

Find the handler: `grep -n "email-triage/suggest-reply" server.js`. The handler already loads: the task, the case row, the GP profile, the open tasks (status not completed/cancelled, limit 20), the qualification snapshot, and the email thread, and computes `senderIsGp`. Locate the spot where it currently builds the context object and calls Anthropic (the context JSON is built ~30622, the Anthropic fetch ~30645). Replace the prompt construction + model call with:

```js
// 1. Stage-scoped playbook (static, cacheable).
var sgStage = (caseRow && caseRow.stage) ? caseRow.stage : '';
var sgPlaybook = registrationPlaybook.playbookForStage(sgStage);

// 2. Reuse the already-cached 24h handover summary for background — DO NOT recompute here.
var sgHandover = '';
try {
  var sgHs = caseRow && caseRow.ai_handover_summary;
  if (typeof sgHs === 'string') sgHs = JSON.parse(sgHs);
  if (sgHs && (sgHs.overview || sgHs.key_history)) {
    sgHandover = [sgHs.overview || '', sgHs.key_history || ''].filter(Boolean).join('\n');
  }
} catch (e) { sgHandover = ''; }

// 3. Compact structured facts (reuse what the handler already assembled).
var sgFacts = {
  stage: sgStage,
  substage: (caseRow && caseRow.substage) || null,
  practice_name: (caseRow && caseRow.practice_name) || null,
  open_tasks: openTasksForContext,        // the already-built mapped open-tasks array
  qualifications: qualSnapshotForContext, // the already-built { required, approved, missing }
};

// 4. Build the grounded, cache-friendly prompt.
var sgMsgs = suggestReplyPrompt.buildSuggestReplyMessages({
  playbookText: sgPlaybook,
  handoverSummary: sgHandover,
  facts: sgFacts,
  threadText: emailThreadText,           // the already-built thread text (or JSON.stringify of the thread array)
  currentEmail: currentEmailText,        // the already-built "from/subject/body" of the email being answered
  senderIsGp: senderIsGp,
});

// 5. Call Anthropic with the lighter current model + cached static system block.
var sgResp = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: JSON.stringify({
    model: SUGGEST_REPLY_MODEL,
    max_tokens: 1000,
    system: sgMsgs.system,
    messages: [{ role: 'user', content: sgMsgs.userText }],
  }),
});
```

Then keep the existing response handling that reads `data.content[0].text` into `suggestedReply` and returns `{ ok, suggestedReply, context }`.

Implementer notes:
- Use the variable names the handler ALREADY has for the mapped open tasks, qual snapshot, thread text, current-email text, `caseRow`, and `senderIsGp` (read the 30551–30687 block and reuse them; the names above — `openTasksForContext`, `qualSnapshotForContext`, `emailThreadText`, `currentEmailText` — are placeholders for whatever the handler already calls them).
- The handler loads the full `registration_cases` row, so `caseRow.ai_handover_summary` is already present — no extra query.
- Keep `max_tokens`, the timeout/abort, and the response shape exactly as they were.

- [ ] **Step 3: Sanity + full suite**

Run: `node --check server.js` → clean.
Run: `./node_modules/.bin/vitest run` → full green (the endpoint isn't unit-tested directly; confirm no regression and that the two new lib test files pass).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(suggest): ground suggest-reply with stage playbook + cached summary; lighter model"
```

---

### Task 4: Wire the hub Inbox / candidate Emails "Suggest a reply" button to the endpoint

**Files:**
- Modify: `pages/admin.html` — the `createHubEmailView` factory's thread composer (the `✦ Suggest a reply` control). Bump the cache-buster.
- Test: visual render (headless Chrome) against a mocked endpoint.

**Interfaces:**
- Consumes: `GET`/`POST` `/api/admin/email-triage/suggest-reply` with `{ taskId }`; the thread `header.latestTaskId` (already returned by `/api/admin/inbox/thread`).
- Produces: clicking Suggest fills the reply textarea with the draft and shows a review note.

- [ ] **Step 1: Add the Suggest control + handler to the composer**

In `createHubEmailView`'s `renderThread`, the composer currently has the "Sending as …" line, the `#hubReply` textarea, and the Send button. Add a Suggest button and a review note above the textarea, and wire it (panel-scoped, like the existing send fix). Find it: `grep -n "createHubEmailView\|hub-composer\|hubReply" pages/admin.html`.

In the composer HTML string add (before the textarea):
```js
'<div class="hub-suggest-row"><button class="hub-suggest"' + (header.latestTaskId ? '' : ' disabled') + '>✦ Suggest a reply</button>' +
'<span class="hub-suggest-note">AI draft — review before sending</span></div>' +
```
After rendering, wire it (alongside the existing back/send wiring), panel-scoped:
```js
var sgBtn = panel.querySelector('.hub-suggest');
if (sgBtn && header.latestTaskId) {
  sgBtn.addEventListener('click', function () {
    sgBtn.disabled = true; sgBtn.textContent = '✦ Drafting…';
    fetch('/api/admin/email-triage/suggest-reply', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: header.latestTaskId }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      var ta = panel.querySelector('#hubReply');
      if (ta && j && j.suggestedReply) ta.value = j.suggestedReply;
      sgBtn.disabled = false; sgBtn.textContent = '✦ Suggest a reply';
    }).catch(function () { sgBtn.disabled = false; sgBtn.textContent = '✦ Suggest a reply'; });
  });
}
```

Add CSS near the other `#hubInboxPanel`/`#gpEmailsPanel` composer rules (scope to BOTH panels so the candidate Emails tab gets it too):
```css
#hubInboxPanel .hub-suggest-row,#gpEmailsPanel .hub-suggest-row{display:flex;align-items:center;gap:10px;padding:10px 12px 0}
#hubInboxPanel .hub-suggest,#gpEmailsPanel .hub-suggest{font-size:12.5px;font-weight:600;color:var(--hub-teal-dark,#0b5b54);background:#f0fdfa;border:1px solid #cdeae5;border-radius:8px;padding:6px 11px;cursor:pointer}
#hubInboxPanel .hub-suggest-note,#gpEmailsPanel .hub-suggest-note{font-size:11.5px;color:var(--muted)}
```

Because the global Inbox and the candidate Emails tab share `createHubEmailView`, this one change covers both.

- [ ] **Step 2: Bump cache-buster**

Bump the admin.html main script tag to the next free letter for today (e.g. `?v=20260628b`).

- [ ] **Step 3: Visual verification (mocked endpoint)**

Render the factory with a mocked `fetch` that returns `{ ok:true, suggestedReply:'…draft…' }` for `/email-triage/suggest-reply` (the same harness approach used for the hub views): confirm the Suggest button appears, the "AI draft — review before sending" note shows, and clicking fills the textarea. Confirm `node --check server.js` and `./node_modules/.bin/vitest run` stay green.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "feat(suggest): wire hub Inbox + candidate Emails Suggest button to grounded endpoint"
```

---

### Task 5: Operator/owner doc + cost note + final verification

**Files:**
- Create: `docs/registration-suggest-reply.md`
- Test: full suite + node --check.

- [ ] **Step 1: Write the doc**

```markdown
# Grounded Suggest-a-Reply

## What it does
The "✦ Suggest a reply" button drafts a reply the RSO reviews and sends (never auto-sent). The AI is given: a small **stage-scoped playbook** (standard guidance for the doctor's current stage), the candidate's **real facts** (stage, open tasks, document/qualification status), the **recent emails**, and a **background summary** reused from the 24h candidate summary. It is instructed to use only those facts and to flag `[RSO: please confirm …]` when unsure.

## Owning the playbook
The per-stage guidance lives in `lib/registration-playbook.js` (`STAGE_PLAYBOOK`). It is plain text — review and refine it as the registration process changes. Keep each stage section tight (under ~1200 chars) so it stays cheap to send.

## Cost / model
- Model: `SUGGEST_REPLY_MODEL` env (default `claude-sonnet-4-6`). For lower cost you can set it to `claude-haiku-4-5` and compare quality; for maximum quality, `claude-opus-4-8`.
- The static block (rules + playbook) is prompt-cached, so repeated suggestions within a few minutes are ~90% cheaper on that portion. Because the playbook is small, each suggestion is roughly a cent regardless of cache state.
- It only runs when the RSO clicks Suggest — never automatically.

## Known follow-ups
- The rest of the app's Anthropic calls still default to the deprecated `claude-opus-4-20250514` (`ANTHROPIC_MODEL`, server.js ~179). Out of scope here; migrate separately to a current model.
- The playbook currently covers myintealth/amc/career(placement)/ahpra/pbs/commencement. Visa is aliased to the AHPRA section (visa is deferred in v1).
```

- [ ] **Step 2: Final verification**

Run: `./node_modules/.bin/vitest run` → full green (baseline + the two new test files).
Run: `node --check server.js` → clean.

- [ ] **Step 3: Commit**

```bash
git add docs/registration-suggest-reply.md
git commit -m "docs(suggest): grounded suggest-reply design, playbook ownership, cost/model"
```

---

## Self-Review

- **Spec coverage:** curated stage playbook (Task 1), grounded static-first prompt + grounding rules (Task 2), reuse cached summary + structured facts + lighter current model on the existing endpoint (Task 3), hub/candidate Suggest button wiring + "review before sending" (Task 4), owner doc + cost note + model-deprecation follow-up (Task 5). All covered.
- **Token-light:** playbook is stage-scoped and size-capped (Task 1 test); summary is read from the cached field, never recomputed (Task 3 Step 2); static block is cached and excludes per-email content (Task 2 test). ✔
- **Grounded / draft-only:** `GROUNDING_RULES` enforces facts-only + `[RSO: confirm]` + no false "complete" claims (Task 2); UI shows "AI draft — review before sending" and never auto-sends (Task 4). ✔
- **Non-destructive:** endpoint request/response shape unchanged (Task 3); only the suggest-reply model changes, not the other call sites (Global Constraints + Task 5 follow-up). ✔
- **Type consistency:** `playbookForStage` → string used as `playbookText` in `buildSuggestReplyMessages` (Tasks 1→2→3); `{system, userText}` shape consumed verbatim in Task 3; `header.latestTaskId` (from the existing thread endpoint) consumed in Task 4. ✔
