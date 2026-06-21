# AHPRA s80 Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AHPRA s80 "request for more information" flow faster for admins, more accurate, clearer for the doctor, and resistant to silent failures.

**Architecture:** Build on the live, prod s80 feature (`lib/ahpra-s80.js` + s80 endpoints in `server.js` + `pages/admin.html` tray + `pages/ahpra.html` GP card). All new data rides in the existing `registration_tasks.metadata` JSON blob — **no database migration**. Delivered in 5 independently-shippable phases; **this document fully specifies Phase 1**, with Phases 2–5 outlined and each to be expanded into its own just-in-time plan (grounded in the real code from the prior phase, so no forward-references to code that doesn't exist yet).

**Tech Stack:** Node.js (single `server.js`), vanilla HTML/JS pages, Supabase (prod) / JSON file (dev), Anthropic API (raw `fetch`), vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-21-ahpra-s80-improvements-design.md`

## Global Constraints

- **AI model:** s80 AI calls use `claude-opus-4-8` (the newest). These models **reject the `temperature` parameter (HTTP 400)** — never send `temperature` on an Opus 4.7/4.8 call.
- **No database migration:** every new field lives in `registration_tasks.metadata` (JSON), consistent with the existing metadata-only s80 design.
- **Tunable constants (one place each, server-side):** `S80_AUTO_CONFIDENCE = 0.92`, `S80_CHASE_DAYS = 7`, `S80_REPLY_HOLD_MINUTES = 10`. (Used from Phase 3/5; defined when first needed.)
- **Plain-English copy:** all GP-facing and admin-facing text is plain, non-technical (owner is non-technical).
- **Dashboard parity:** s80 render logic that exists in both `pages/admin.html` and `pages/ceo-dashboard.html` must be kept in sync — change both.
- **Commit & push** after each task (project rule). Tests run with `npm test` (vitest).
- **Honesty:** never mark anything "sent"/"done" unless it actually succeeded; report manual/preview testing as manual.

---

## Phase overview

1. **Foundations (this plan, full detail):** newest model + `temperature` removed for s80 extraction; per-item AI `confidence` + `reason` captured and shown in the admin tray.
2. **GP clarity:** progress tracker, deadline countdown, plain per-item statuses, read-only team-item visibility, CC banner.
3. **Close the loop:** institution-confirmation proof upload, AI thread-watch in the daily cron, 7-day auto-chase.
4. **Admin speed:** AI upload pre-check; send the AHPRA reply from the app (needs `gmail.send` scope).
5. **Turn on automation:** auto-release / auto-approve / auto-send gated on `S80_AUTO_CONFIDENCE`, with audit + RSO notify + 10-minute reply cancel window.

---

## File structure (Phase 1)

- **Modify** `lib/ahpra-s80.js` — `buildExtractionPrompt` (add `confidence`/`reason` to the JSON contract) and `normalizeItem` (parse + clamp them into each item). Pure logic; unit-tested.
- **Modify** `tests/ahpra-s80.test.js` — add a `describe` block for confidence/reason parsing.
- **Modify** `server.js` — add `ANTHROPIC_S80_MODEL` constant; switch the s80 extraction `fetch` to it and drop `temperature`; persist `ai_confidence`/`ai_reason` into bundle task metadata.
- **Modify** `pages/admin.html` — `renderS80Tray` shows a confidence badge + reason per item.

> **Note on testing reality:** this codebase has unit tests only for `lib/` (vitest). `server.js` (network/DB) and the vanilla HTML pages have **no** automated test harness. So Task 1 is full TDD; Tasks 2–3 use concrete code + explicit read/grep/manual verification, stated honestly.

---

### Task 1: Capture AI `confidence` + `reason` in the extraction logic

**Files:**
- Modify: `lib/ahpra-s80.js` (`buildExtractionPrompt` ~lines 59–105; `normalizeItem` ~lines 196–279)
- Test: `tests/ahpra-s80.test.js`

**Interfaces:**
- Consumes: existing `s80.normalizeItem(raw, ctx)` and `s80.buildExtractionPrompt(emailMeta, opts)`.
- Produces: `normalizeItem(...)` return object gains `confidence: number` (clamped to `[0,1]`, default `0`) and `reason: string` (default `''`). Phase 2+ and `server.js` read these as `item.confidence` / `item.reason`.

- [ ] **Step 1: Write the failing tests**

Add to the end of `tests/ahpra-s80.test.js`:

```js
describe('s80 AI confidence + reason', () => {
  it('captures confidence and reason on a normalised item', () => {
    const item = s80.normalizeItem({
      title: 'Certificate of Good Standing from GMC',
      detail: 'Send a Certificate of Good Standing from the GMC directly to AHPRA.',
      owner: 'gp', mode: 'request_institution', kind: 'good_standing',
      confidence: 0.97, reason: 'Good standing certificate → GP requests it from the GMC.'
    }, { country: 'uk' });
    expect(item.confidence).toBe(0.97);
    expect(item.reason).toBe('Good standing certificate → GP requests it from the GMC.');
  });

  it('clamps out-of-range confidence into [0, 1]', () => {
    expect(s80.normalizeItem({ title: 'X', confidence: 1.8 }, {}).confidence).toBe(1);
    expect(s80.normalizeItem({ title: 'X', confidence: -0.5 }, {}).confidence).toBe(0);
  });

  it('defaults confidence to 0 and reason to "" when the model omits them', () => {
    const item = s80.normalizeItem({ title: 'X' }, {});
    expect(item.confidence).toBe(0);
    expect(item.reason).toBe('');
  });

  it('ignores a non-numeric confidence (defaults to 0)', () => {
    expect(s80.normalizeItem({ title: 'X', confidence: 'high' }, {}).confidence).toBe(0);
  });

  it('asks the model for confidence and reason in the extraction prompt', () => {
    const p = s80.buildExtractionPrompt(
      { subject: 's80 notice', sender: 'officer@ahpra.gov.au', bodyText: 'We need documents.' },
      {}
    );
    expect(p).toContain('confidence');
    expect(p).toContain('reason');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ahpra-s80.test.js -t "AI confidence"`
Expected: FAIL — the new assertions fail (`item.confidence` is `undefined`; prompt lacks "confidence"/"reason").

- [ ] **Step 3: Add `confidence` + `reason` to the extraction prompt contract**

In `lib/ahpra-s80.js`, inside `buildExtractionPrompt`, add two bullets to the per-item instruction list immediately **after** the `- "kind":` bullet (the line beginning `'- "kind": one of "supervised_practice_plan"...'`):

```js
    '- "confidence": a number from 0 to 1 — how sure you are about this item\'s owner/mode/kind',
    '  classification (1 = certain, 0 = a guess).',
    '- "reason": one short sentence explaining the owner/mode choice in plain English',
    '  (e.g. "Certificate of Good Standing -> the GP requests it from the GMC").',
```

Then update the strict-JSON shape line (the one starting `'{"deadline":...`) so each item object includes the two new keys — change the item object to:

```js
    '{"deadline":"YYYY-MM-DD"|null,"reference":"string"|null,"items":[{"title":"","detail":"","gp_instructions":"","sub_items":[],"owner":"gp|team","mode":"upload|request_institution|team","institution":"","kind":"","confidence":0.0,"reason":""}]}',
```

- [ ] **Step 4: Parse + clamp `confidence` and `reason` in `normalizeItem`**

In `lib/ahpra-s80.js`, inside `normalizeItem`, just before the final `return {` block, add:

```js
  var confidence = (typeof raw.confidence === 'number' && isFinite(raw.confidence))
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;
  var reason = cleanString(raw.reason || '', 300);
```

Then add the two fields to the returned object (e.g. after the `kind: kind` line):

```js
    kind: kind,
    confidence: confidence,
    reason: reason
```

(Adjust the trailing comma so the object stays valid — `kind: kind,` then the two new lines, no trailing comma after `reason: reason`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/ahpra-s80.test.js`
Expected: PASS — the new block passes and all 35 existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add lib/ahpra-s80.js tests/ahpra-s80.test.js
git commit -m "AHPRA s80: capture per-item AI confidence + reason in extraction"
```

---

### Task 2: Use the newest model (no temperature) for s80 extraction + persist confidence/reason

**Files:**
- Modify: `server.js` — model constants (~line 198), the s80 extraction `fetch` (lines 1918–1924), the bundle metadata object (lines 2014–2037)

**Interfaces:**
- Consumes: `item.confidence` / `item.reason` from Task 1's `normalizeExtraction` output.
- Produces: each `ahpra_action_item` task's `metadata` gains `ai_confidence: number` and `ai_reason: string`. Phase 1 Task 3 (admin tray) and Phases 2/5 read `metadata.ai_confidence` / `metadata.ai_reason`.

- [ ] **Step 1: Add a dedicated s80 model constant**

In `server.js`, immediately after the `ANTHROPIC_SCAN_MODEL` definition (line 198), add:

```js
// AHPRA s80 extraction runs on the newest model. Opus 4.7/4.8 reject `temperature`,
// so the s80 extraction call below must NOT send it (see _extractAhpraActionItems).
const ANTHROPIC_S80_MODEL = String(process.env.ANTHROPIC_S80_MODEL || 'claude-opus-4-8').trim() || 'claude-opus-4-8';
```

- [ ] **Step 2: Point the extraction call at the new model and remove `temperature`**

In `server.js`, in the s80 extraction `fetch` body (lines 1918–1924), change `model: ANTHROPIC_MODEL,` to `model: ANTHROPIC_S80_MODEL,` and **delete** the `temperature: 0,` line. The body becomes:

```js
      body: JSON.stringify({
        model: ANTHROPIC_S80_MODEL,
        max_tokens: 4000,
        system: ahpraS80.EXTRACTION_SYSTEM,
        messages: [{ role: 'user', content: prompt }]
      })
```

- [ ] **Step 3: Persist `ai_confidence` + `ai_reason` into the bundle task metadata**

In `server.js`, in the `meta` object built inside `_createAhpraS80Bundle` (lines 2014–2037), add two fields (e.g. after the `kind: item.kind || '',` line):

```js
      kind: item.kind || '',
      ai_confidence: (typeof item.confidence === 'number') ? item.confidence : 0,
      ai_reason: item.reason || '',
```

- [ ] **Step 4: Verify the change statically (no `temperature`, right model, fields persisted)**

Run:
```bash
sed -n '1918,1925p' server.js
grep -n "ANTHROPIC_S80_MODEL" server.js
grep -n "ai_confidence\|ai_reason" server.js
```
Expected: the extraction body shows `model: ANTHROPIC_S80_MODEL` and **no** `temperature`; the constant is defined and used; `ai_confidence`/`ai_reason` appear in the `_createAhpraS80Bundle` meta block.

- [ ] **Step 5: Run the full test suite (nothing regressed)**

Run: `npm test`
Expected: PASS — all suites green (this change is config + a metadata field; `lib` tests still pass).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "AHPRA s80: run extraction on Opus 4.8 (no temperature); persist AI confidence/reason"
```

---

### Task 3: Show AI confidence + reason in the admin review tray

**Files:**
- Modify: `pages/admin.html` — s80 helpers (`renderS80GpPreview`/`renderS80Tray` area, ~lines 2739–2779)

**Interfaces:**
- Consumes: `metadata.ai_confidence` / `metadata.ai_reason` (from Task 2) via the existing `s80Meta(t)` accessor (`m.ai_confidence` / `m.ai_reason`).
- Produces: a confidence badge + reason rendered in each tray item, above the Who/How dropdown row.

- [ ] **Step 1: Add a confidence-render helper**

In `pages/admin.html`, immediately **after** the `renderS80GpPreview` function (ends ~line 2749), add:

```js
  // AI's self-rated confidence + one-line reason for this item's Who/How.
  function renderS80Confidence(m){
    var pct = (typeof m.ai_confidence === 'number') ? Math.round(m.ai_confidence * 100) : null;
    if(pct === null && !m.ai_reason) return '';
    var col = pct === null ? '#64748b' : (pct >= 92 ? '#15803d' : pct >= 70 ? '#b45309' : '#b91c1c');
    var bg  = pct === null ? '#f1f5f9' : (pct >= 92 ? '#dcfce7' : pct >= 70 ? '#fef3c7' : '#fee2e2');
    var label = pct === null ? 'AI: unscored' : ('AI confidence ' + pct + '%');
    return '<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
      + '<span style="font-size:10px;font-weight:700;color:' + col + ';background:' + bg + ';border-radius:5px;padding:2px 7px;">' + label + '</span>'
      + (m.ai_reason ? '<span style="font-size:11px;color:var(--muted);">' + esc(m.ai_reason) + '</span>' : '')
      + '</div>';
  }
```

> The `92` here is only a display colour cue; the real auto-release gate (`S80_AUTO_CONFIDENCE`) is a server-side constant added in Phase 5.

- [ ] **Step 2: Render it in the tray, above the Who/How row**

In `renderS80Tray`, in the per-item loop, add the call immediately **after** the `html+=renderS80GpPreview(m);` line and **before** the `html+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">';` line (the Who/How row):

```js
        html+=renderS80GpPreview(m);
        html+=renderS80Confidence(m);
```

- [ ] **Step 3: Check dashboard parity**

Run: `grep -n "renderS80Tray\|renderS80Confidence" pages/ceo-dashboard.html`
- If `renderS80Tray` exists in `ceo-dashboard.html`, repeat Steps 1–2 there (mirror the helper + the call).
- If it does not (the holding tray is admin-only), no change — note this in the commit message.

- [ ] **Step 4: Manual verification (no UI test harness exists)**

Manually (and report it as manual): run `npm start`, open the admin dashboard for a GP that has a `pending_review` s80 bundle (or log a test letter via "Log AHPRA letter"), hard-refresh, and confirm each tray item shows the confidence badge + reason above the Who/How dropdowns. If no AI key is configured locally, confirm instead that items without a score render "AI: unscored" and no error is thrown (inspect the console).

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "AHPRA s80: show AI confidence + reason in the admin review tray"
```

---

## Phases 2–5 (outline — each becomes its own just-in-time plan)

> Written as scope summaries, not bite-sized steps, because their exact code depends on the
> code that Phase 1 (and each preceding phase) actually lands. Expand each into a full plan
> with `superpowers:writing-plans` immediately before executing it.

### Phase 2 — GP clarity (`pages/ahpra.html`, `server.js`)
- `renderAhpraMoreInfoCard` / `ahpraMoreInfoItemHtml`: add a **progress tracker** ("N of M done" + bar) and a **deadline countdown** with urgency colour.
- Make per-item statuses explicit (To do → Uploaded/under review → Accepted/Not accepted; To do → Requested/awaiting AHPRA → Confirmed received).
- Extend `GET /api/ahpra/more-info` to also return **team-owned items as read-only summaries** (title only, never the officer's raw words); render them greyed and non-actionable.
- Add the **CC-the-team banner** (depends on the assigned-RSO address lookup, finalized in Phase 3).
- Verification: manual (UX); no UI harness.

### Phase 3 — Close the institution loop (`server.js`, daily cron, `pages/ahpra.html`)
- **Proof upload:** new field `metadata.proof` + endpoint for the GP to forward the institution's "sent to AHPRA" confirmation; surface to admin.
- **AI thread-watch:** extend the daily reconciliation cron to read the AHPRA thread (visible via the CC) with Opus 4.8 and set `metadata.received_confirmed_at` / flag outstanding. Idempotent.
- **Auto-chase:** define `S80_CHASE_DAYS = 7`; nudge the GP + alert the RSO when requested-but-unconfirmed past the window; escalate near deadline. Reuse the existing nudge mechanism.
- Define the **assigned-RSO CC address** lookup (assigned VA / `rso_team`, fallback to team archive) — shared with Phase 2's banner.

### Phase 4 — Admin speed (`server.js`, `pages/admin.html`)
- **AI upload pre-check** on `PUT /api/ahpra/more-info/upload`: store `metadata.upload.ai_match = {matches, confidence, reason}`; reuse the existing doc-AI plumbing (`ensureDocReviewOnUpload`, `/api/admin/va/doc-review/ai-scan`, certified-copy detection); show the verdict in `renderS80Active`.
- **Send reply from app:** `POST /api/admin/ahpra/reply/send` posts `buildCombinedReplyDraft` on the original thread with approved files attached, then marks the reply task complete. **Prerequisite:** `gmail.send` scope for the team account; degrade gracefully to copy-draft if unavailable.

### Phase 5 — Turn on automation (`lib/ahpra-s80.js`, `server.js`)
- Add pure, unit-tested predicate `bundleAutoReleasable(items, threshold)` to `lib/ahpra-s80.js` (all items ≥ threshold AND none `needs_split`/unknown-kind).
- Extract `_releaseS80Bundle(caseId, bundleId)` shared helper from `POST /api/admin/ahpra/release`; call it from `_createAhpraS80Bundle` when the predicate passes (**auto-release**).
- **Auto-approve** GP uploads when `ai_match.matches && confidence >= S80_AUTO_CONFIDENCE` (+ certified-copy OK).
- **Auto-send** the reply with a `S80_REPLY_HOLD_MINUTES = 10` cancel window.
- Define `S80_AUTO_CONFIDENCE = 0.92`; every auto-action → `_logCaseEvent` + RSO notification.

---

## Self-review (Phase 1 vs spec)

- **Spec coverage (Phase 1 scope):** newest model → Task 2; remove temperature → Task 2; per-item confidence + reason → Task 1 (capture) + Task 2 (persist) + Task 3 (show); structured-output upgrade is deferred (the spec lists it as "prefer"; current regex parse keeps working — captured here as a Phase-1-optional, not blocking). Phases 2–5 spec sections → outlined with explicit file targets. ✓
- **Placeholder scan:** every Phase 1 step has concrete code/commands; no TBD/“handle errors”/“similar to”. ✓
- **Type consistency:** `item.confidence` (number) / `item.reason` (string) produced by Task 1 → read by Task 2 → stored as `metadata.ai_confidence` / `metadata.ai_reason` → read by Task 3 as `m.ai_confidence` / `m.ai_reason`. Names consistent end-to-end. ✓
