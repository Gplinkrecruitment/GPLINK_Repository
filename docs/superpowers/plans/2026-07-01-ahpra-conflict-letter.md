# AHPRA Conflict-of-Interest Management Letter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an SPPA-00 conflict of interest exists and an AHPRA officer is assigned, create one canonical admin task whose pre-filled email asks the practice to email the assigned officer a conflict-management statement (CC'ing us for auto-close), deduped against the authorised-correspondent flow.

**Architecture:** A pure lib (`lib/ahpra-conflict-letter.js`) holds all testable logic (email builder, CC-confirmation matcher, gate predicate). An idempotent `server.js` helper `_ensureAhpraConflictLetter(caseId, opts)` creates the single task, invoked from three triggers (officer-assigned, conflict-set-late, officer-asks) that all converge on it. A suppression guard stops the generic `ahpra_correspondence` duplicate. An inbound matcher auto-closes on the practice→officer CC. UI reuses the existing `.ops-email-composer` card in both dashboards.

**Tech Stack:** Vanilla Node.js (`server.js`), plain HTML/JS pages, Supabase via `supabaseDbRequest` (PostgREST), vitest tests, pdf-lib (unrelated). Deployed on Vercel; prod = push `origin/main`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-01-ahpra-conflict-management-letter-design.md`.
- **Base:** worktree `worktree-ahpra-conflict-letter` on `origin/main` @ 66f9866. Build against the worktree's actual code — the previous local checkout was 439 commits behind; **verify every anchor symbol in the worktree, never trust line numbers from memory**.
- **New `task_type`:** `ahpra_conflict_letter` (exact string, everywhere).
- **PostgREST gotcha:** every `LIKE` wildcard passed to `supabaseDbRequest` MUST be `%25`, never a bare `%` (the query string is concatenated raw).
- **task_type CHECK constraint:** adding a new task_type silently fails to INSERT unless the **live** `registration_tasks_task_type_check` is rebuilt to include it. Read the LIVE constraint via `rpc/exec_sql` (service key in `.env`, NOT `.env.prod`); do not trust migration files.
- **Never auto-send.** The practice email is always a suggested draft the RSO sends.
- **Pattern to mirror:** `_ensureAltSupervisorCvRequest` (server.js) + `lib/sppa-alt-supervisor-request.js` + the `data-ops-send-email` / `data-ops-flip-status="waiting_on_practice"` composer.
- **Verification floor:** `node --check server.js` clean and full `npm test` green (851 tests at base) before any commit that touches server.js.
- **Commit trailers (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013gw6LKU7dkP6wXdY9i1du6
  ```

## File Structure

- **Create** `lib/ahpra-conflict-letter.js` — pure: `buildConflictLetterEmail`, `isConflictLetterConfirmation`, `shouldEnsureConflictLetter`, helpers.
- **Create** `tests/ahpra-conflict-letter.test.js` — unit tests for the lib.
- **Modify** `server.js` — `require` the lib; `_ensureAhpraConflictLetter` helper; triggers A/B/C; suppression in `_processAhpraEmail`; auto-close matcher in the inbound pipeline.
- **Modify** `pages/admin.html` — `_hasDetailPanel` entry; `renderOpsAhpraConflictLetter`; dispatch in Ops Queue + GP-profile panes.
- **Modify** `pages/ceo-dashboard.html` — parity render + dispatch.
- **Create** `supabase/migrations/20260701000000_add_ahpra_conflict_letter_task_type.sql` — constraint union (mirrors the prod `exec_sql` apply).

---

### Task 1: Pure email builder `buildConflictLetterEmail`

**Files:**
- Create: `lib/ahpra-conflict-letter.js`
- Test: `tests/ahpra-conflict-letter.test.js`

**Interfaces:**
- Produces: `buildConflictLetterEmail({ gpName, supervisorName, practiceName, contactName, officerName, officerEmail, ccEmail, rsoSignoffName }) -> { subject: string, bodyHtml: string }`. Subject is a plain header (NOT HTML-escaped); body is HTML-escaped.

- [ ] **Step 1: Write the failing test**

```js
// tests/ahpra-conflict-letter.test.js
import { describe, it, expect } from 'vitest';
import { buildConflictLetterEmail } from '../lib/ahpra-conflict-letter.js';

describe('buildConflictLetterEmail', () => {
  const base = {
    gpName: 'Smith Miller', supervisorName: 'Dr John Miller',
    practiceName: 'SOP Medical Centre', contactName: 'Reception',
    officerName: 'Jane Officer', officerEmail: 'jane.officer@ahpra.gov.au',
    ccEmail: 'hazel@mygplink.com.au', rsoSignoffName: 'Hazel'
  };

  it('interpolates the dynamic officer, supervisor, GP and CC into the body', () => {
    const { subject, bodyHtml } = buildConflictLetterEmail(base);
    expect(subject).toBe('Conflict-of-interest confirmation for Dr Smith Miller — please email AHPRA');
    expect(bodyHtml).toContain('Dr John Miller');
    expect(bodyHtml).toContain('jane.officer@ahpra.gov.au');
    expect(bodyHtml).toContain('hazel@mygplink.com.au');
    expect(bodyHtml).toContain('not impair');
    expect(bodyHtml).toContain('SOP Medical Centre');
    expect(bodyHtml).toContain('Hazel — GP Link Registration Team');
  });

  it('HTML-escapes interpolated values in the body but not the subject', () => {
    const { subject, bodyHtml } = buildConflictLetterEmail({ ...base, practiceName: 'A & B <Clinic>' });
    expect(bodyHtml).toContain('A &amp; B &lt;Clinic&gt;');
    const subj = buildConflictLetterEmail({ ...base, gpName: 'A & B' }).subject;
    expect(subj).toContain('A & B'); // subject is a plain header, not escaped
  });

  it('falls back gracefully when optional fields are blank', () => {
    const { bodyHtml } = buildConflictLetterEmail({ gpName: 'Test GP' });
    expect(bodyHtml).toContain('Dear Practice Contact,');
    expect(bodyHtml).toContain('the supervisor');
    expect(bodyHtml).toContain('GP Link Registration Team');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ahpra-conflict-letter.test.js`
Expected: FAIL — "Cannot find module '../lib/ahpra-conflict-letter.js'".

- [ ] **Step 3: Write minimal implementation**

```js
// lib/ahpra-conflict-letter.js
'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildConflictLetterEmail(params) {
  params = params || {};
  var gpName = String(params.gpName == null ? '' : params.gpName).trim();
  var supervisorName = String(params.supervisorName == null ? '' : params.supervisorName).trim() || 'the supervisor';
  var practiceName = String(params.practiceName == null ? '' : params.practiceName).trim() || 'the practice';
  var contactName = String(params.contactName == null ? '' : params.contactName).trim() || 'Practice Contact';
  var officerName = String(params.officerName == null ? '' : params.officerName).trim() || 'the AHPRA officer';
  var officerEmail = String(params.officerEmail == null ? '' : params.officerEmail).trim();
  var ccEmail = String(params.ccEmail == null ? '' : params.ccEmail).trim();
  var rsoSignoffName = String(params.rsoSignoffName == null ? '' : params.rsoSignoffName).trim();

  // Subject is a plain email header — do NOT HTML-escape.
  var subject = 'Conflict-of-interest confirmation for Dr ' + gpName + ' — please email AHPRA';

  var officerLine = escapeHtml(officerName) + (officerEmail ? ' (' + escapeHtml(officerEmail) + ')' : '');
  var ccClause = ccEmail ? ' and <b>CC us (' + escapeHtml(ccEmail) + ')</b> so we have it on file' : '';
  var signoff = rsoSignoffName ? (escapeHtml(rsoSignoffName) + ' — GP Link Registration Team') : 'GP Link Registration Team';

  var bodyHtml = [
    'Dear ' + escapeHtml(contactName) + ',',
    '',
    'As part of Dr ' + escapeHtml(gpName) + '’s AHPRA supervised-practice application, the SPPA-00 supervised practice plan noted that the supervisor, ' + escapeHtml(supervisorName) + ', is also the owner/principal of ' + escapeHtml(practiceName) + '.',
    '',
    'AHPRA requires a short statement from the practice confirming how this potential conflict of interest will be managed and that it will <b>not impair ' + escapeHtml(supervisorName) + '’s ability to supervise</b> Dr ' + escapeHtml(gpName) + '.',
    '',
    'Could you please email this confirmation directly to the AHPRA officer handling the application — ' + officerLine + ccClause + '?',
    '',
    'Suggested wording you can adapt: “Although ' + escapeHtml(supervisorName) + ' is both the supervisor and owner/principal of ' + escapeHtml(practiceName) + ', this will not impair their ability to provide appropriate supervision to Dr ' + escapeHtml(gpName) + '. Any potential conflicts of interest will be managed by …”',
    '',
    'Kind regards,',
    signoff
  ].join('<br>');

  return { subject: subject, bodyHtml: bodyHtml };
}

module.exports = { buildConflictLetterEmail };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ahpra-conflict-letter.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ahpra-conflict-letter.js tests/ahpra-conflict-letter.test.js
git commit -m "feat: conflict-letter email builder (pure, TDD)" # + trailers
```

---

### Task 2: CC-confirmation matcher `isConflictLetterConfirmation`

**Files:**
- Modify: `lib/ahpra-conflict-letter.js`
- Test: `tests/ahpra-conflict-letter.test.js`

**Interfaces:**
- Produces: `isConflictLetterConfirmation(emailMeta, { practiceEmail, officerEmail }) -> boolean`. True when the email is FROM the practice and the officer address appears in To/Cc. Tolerates `to`/`cc` as arrays or comma-strings and `"Name <addr>"` forms.

- [ ] **Step 1: Write the failing test** (append to `tests/ahpra-conflict-letter.test.js`)

```js
import { isConflictLetterConfirmation } from '../lib/ahpra-conflict-letter.js';

describe('isConflictLetterConfirmation', () => {
  const ctx = { practiceEmail: 'reception@sopclinic.com.au', officerEmail: 'jane.officer@ahpra.gov.au' };

  it('matches a practice→officer email that CCs us (officer in To)', () => {
    const meta = { sender: 'Reception <reception@sopclinic.com.au>',
      to: 'jane.officer@ahpra.gov.au', cc: 'hazel@mygplink.com.au' };
    expect(isConflictLetterConfirmation(meta, ctx)).toBe(true);
  });

  it('matches when to/cc are arrays and officer is in cc', () => {
    const meta = { sender: 'reception@sopclinic.com.au',
      to: ['someone@x.com'], cc: ['hazel@mygplink.com.au', 'Jane <jane.officer@ahpra.gov.au>'] };
    expect(isConflictLetterConfirmation(meta, ctx)).toBe(true);
  });

  it('rejects when sender is not the practice', () => {
    const meta = { sender: 'random@gmail.com', to: 'jane.officer@ahpra.gov.au' };
    expect(isConflictLetterConfirmation(meta, ctx)).toBe(false);
  });

  it('rejects when the officer is not a recipient', () => {
    const meta = { sender: 'reception@sopclinic.com.au', to: 'hazel@mygplink.com.au' };
    expect(isConflictLetterConfirmation(meta, ctx)).toBe(false);
  });

  it('rejects when context is incomplete', () => {
    expect(isConflictLetterConfirmation({ sender: 'reception@sopclinic.com.au' }, { practiceEmail: '', officerEmail: '' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ahpra-conflict-letter.test.js`
Expected: FAIL — `isConflictLetterConfirmation is not a function`.

- [ ] **Step 3: Write minimal implementation** (add to `lib/ahpra-conflict-letter.js`, export it)

```js
function normalizeEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

function extractEmail(v) {
  var s = String(v == null ? '' : v);
  var m = s.match(/<([^>]+)>/);
  return normalizeEmail(m ? m[1] : s);
}

function isConflictLetterConfirmation(emailMeta, ctx) {
  emailMeta = emailMeta || {};
  ctx = ctx || {};
  var practiceEmail = normalizeEmail(ctx.practiceEmail);
  var officerEmail = normalizeEmail(ctx.officerEmail);
  if (!practiceEmail || !officerEmail) return false;
  var from = extractEmail(emailMeta.sender != null ? emailMeta.sender : emailMeta.from);
  if (from !== practiceEmail) return false;
  var recipientsBlob = [emailMeta.to, emailMeta.cc, emailMeta.recipient]
    .map(function (x) { return Array.isArray(x) ? x.join(' ') : String(x == null ? '' : x); })
    .join(' ').toLowerCase();
  return recipientsBlob.indexOf(officerEmail) !== -1;
}
// update module.exports to include isConflictLetterConfirmation
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ahpra-conflict-letter.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/ahpra-conflict-letter.js tests/ahpra-conflict-letter.test.js
git commit -m "feat: practice→officer CC confirmation matcher (TDD)" # + trailers
```

---

### Task 3: Gate predicate `shouldEnsureConflictLetter`

**Files:**
- Modify: `lib/ahpra-conflict-letter.js`
- Test: `tests/ahpra-conflict-letter.test.js`

**Interfaces:**
- Produces: `shouldEnsureConflictLetter({ hasConflict, officerEmail }) -> boolean`. True only when a conflict exists AND an officer email is known. Used by all three triggers as the common gate.

- [ ] **Step 1: Write the failing test** (append)

```js
import { shouldEnsureConflictLetter } from '../lib/ahpra-conflict-letter.js';

describe('shouldEnsureConflictLetter', () => {
  it('true only when conflict AND officer email both present', () => {
    expect(shouldEnsureConflictLetter({ hasConflict: true, officerEmail: 'o@ahpra.gov.au' })).toBe(true);
  });
  it('false when no conflict', () => {
    expect(shouldEnsureConflictLetter({ hasConflict: false, officerEmail: 'o@ahpra.gov.au' })).toBe(false);
  });
  it('false when no officer email', () => {
    expect(shouldEnsureConflictLetter({ hasConflict: true, officerEmail: '' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/ahpra-conflict-letter.test.js` → FAIL (`shouldEnsureConflictLetter is not a function`).

- [ ] **Step 3: Implement**

```js
function shouldEnsureConflictLetter(ctx) {
  ctx = ctx || {};
  return !!(ctx.hasConflict && String(ctx.officerEmail == null ? '' : ctx.officerEmail).trim());
}
// final module.exports = { buildConflictLetterEmail, isConflictLetterConfirmation, shouldEnsureConflictLetter };
```

- [ ] **Step 4: Run** → PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/ahpra-conflict-letter.js tests/ahpra-conflict-letter.test.js
git commit -m "feat: conflict-letter gate predicate (TDD)" # + trailers
```

---

### Task 4: Server helper `_ensureAhpraConflictLetter` + proactive triggers A & B

**Files:**
- Modify: `server.js` (require the lib near the other `lib/sppa-*` requires; add the helper near `_ensureAltSupervisorCvRequest`; call it at trigger sites)

**Interfaces:**
- Consumes: `buildConflictLetterEmail`, `shouldEnsureConflictLetter` from `lib/ahpra-conflict-letter.js`.
- Produces: `async _ensureAhpraConflictLetter(caseId, opts)` where `opts = { officerName, officerEmail, officerRequestMessageId }`. Idempotent. Returns the task row (existing or created) or `null` if gated out.

**Implementation notes (read the worktree to confirm anchors):**
- Mirror `_ensureAltSupervisorCvRequest` exactly for: the in-process lock object, the `status != 'completed'` existence check, the case/profile/practice lookups, and the metadata shape.
- Read conflict from the SPPA-00 task: `registration_tasks?select=metadata&case_id=eq.<id>&related_document_key=eq.sppa_00&limit=1`, parse `metadata` (string-or-object), `meta.is_conflict === true`. Pull `supervisor_name`, `practice_owner_name` from the same metadata.
- `ccEmail` = the case's RSO sender mailbox via the existing `resolveCaseSenderEmail`/`resolveCaseSenderInfo` (used by the alt-CV path).
- Build the email via `buildConflictLetterEmail(...)`; store `suggested_subject`/`suggested_body`/`practice_email`/`practice_contact_name`/`ahpra_officer_name`/`ahpra_officer_email`/`cc_mailbox`/`gp_name`/`supervisor_name`/`practice_name` in metadata; `status:'open'`, `related_stage:'ahpra'`, `related_document_key:'sppa_00'`, `priority:'high'`, `title:'Conflict of interest — ask practice to email AHPRA officer'`.
- Trigger A: in the main Gmail loop, immediately after the officer PATCH that sets `ahpra_officer_email` (the `finalPatch`/`ahpraPatch` block), call `_ensureAhpraConflictLetter(gpCase.id, { officerName, officerEmail })` (fire-and-forget `.catch`) guarded by `shouldEnsureConflictLetter`.
- Trigger B: in the Q7-override endpoint (`sppa-override-q7`, after writing `is_conflict`) and in the conflict-scan completion, if the case already has an `ahpra_officer_email`, call the helper.

- [ ] **Step 1: Add the `require`** near the other lib requires (e.g. beside `lib/sppa-alt-supervisor-request.js`):

```js
const { buildConflictLetterEmail, isConflictLetterConfirmation, shouldEnsureConflictLetter } = require('./lib/ahpra-conflict-letter.js');
```

- [ ] **Step 2: Add the helper** (mirror `_ensureAltSupervisorCvRequest`):

```js
var _ahpraConflictLetterInflight = {};
async function _ensureAhpraConflictLetter(caseId, opts) {
  opts = opts || {};
  if (!caseId) return null;
  if (_ahpraConflictLetterInflight[caseId]) return null;
  _ahpraConflictLetterInflight[caseId] = true;
  try {
    // 1) existing open task? reuse it (and optionally attach officer request)
    var existing = await supabaseDbRequest('registration_tasks',
      'select=id,metadata,status&case_id=eq.' + encodeURIComponent(caseId) +
      '&task_type=eq.ahpra_conflict_letter&status=neq.completed&limit=1');
    if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
      return existing.data[0];
    }
    // 2) confirm a conflict exists + gather names
    var sppaRes = await supabaseDbRequest('registration_tasks',
      'select=metadata&case_id=eq.' + encodeURIComponent(caseId) +
      '&related_document_key=eq.sppa_00&limit=1');
    var sMeta = (sppaRes.ok && sppaRes.data && sppaRes.data[0]) ? sppaRes.data[0].metadata : null;
    if (typeof sMeta === 'string') { try { sMeta = JSON.parse(sMeta); } catch (e) { sMeta = {}; } }
    sMeta = sMeta || {};
    var officerEmail = String(opts.officerEmail || '').trim();
    if (!shouldEnsureConflictLetter({ hasConflict: sMeta.is_conflict === true, officerEmail: officerEmail })) return null;
    // 3) case → user → practice + gp name + cc mailbox (mirror alt-CV lookups)
    // ...resolve gpName, practiceEmail, practiceContactName, practiceName, ccEmail (resolveCaseSenderEmail)...
    var email = buildConflictLetterEmail({
      gpName: gpName, supervisorName: sMeta.supervisor_name || '', practiceName: practiceName,
      contactName: practiceContactName, officerName: opts.officerName || sMeta.ahpra_officer_name || '',
      officerEmail: officerEmail, ccEmail: ccEmail, rsoSignoffName: rsoSignoffName
    });
    var meta = {
      suggested_subject: email.subject, suggested_body: email.bodyHtml,
      practice_email: practiceEmail, practice_contact_name: practiceContactName,
      ahpra_officer_name: opts.officerName || '', ahpra_officer_email: officerEmail,
      cc_mailbox: ccEmail, gp_name: gpName, supervisor_name: sMeta.supervisor_name || '',
      practice_name: practiceName
    };
    if (opts.officerRequestMessageId) meta.officer_request_message_id = opts.officerRequestMessageId;
    var created = await _createRegTask(caseId, {
      task_type: 'ahpra_conflict_letter', title: 'Conflict of interest — ask practice to email AHPRA officer',
      source_trigger: opts.officerRequestMessageId ? 'officer_request' : 'officer_assigned',
      related_stage: 'ahpra', related_document_key: 'sppa_00', status: 'open', priority: 'high',
      metadata: meta, _actor: 'system'
    });
    return created;
  } catch (e) { console.error('[ahpra-conflict-letter] ensure failed:', e.message); return null; }
  finally { delete _ahpraConflictLetterInflight[caseId]; }
}
```

- [ ] **Step 3: Wire triggers A & B** at the two anchors described above (fire-and-forget with `.catch`).

- [ ] **Step 4: Verify** `node --check server.js` (clean) and run `npx vitest run` (851+ tests green; no behavior change to existing paths because the helper is gated and fire-and-forget).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: _ensureAhpraConflictLetter helper + proactive triggers (officer-assigned, conflict-set)" # + trailers
```

---

### Task 5: Reactive trigger C + suppression in `_processAhpraEmail`

**Files:**
- Modify: `server.js` (`_processAhpraEmail`, the `conflict_followup` / `response_type==='request_from_practice'` branch + the `ahpra_correspondence` creation)

**Implementation notes:**
- In `_processAhpraEmail`, after triage, compute `isConflictFollowup = triage.category === 'conflict_followup' || triage.response_type === 'request_from_practice'`.
- Read the case's conflict (same SPPA-00 metadata read) and `ahpra_officer_email`.
- If `isConflictFollowup` AND conflict exists: call `await _ensureAhpraConflictLetter(caseId, { officerName, officerEmail, officerRequestMessageId: currentMsgId })`, and **skip** the generic `ahpra_correspondence` creation for this email (the suppression guard). Leave all non-conflict emails exactly as today.

- [ ] **Step 1: Implement** the branch + suppression (guard the existing `ahpra_correspondence` insert with `if (!suppressedByConflictLetter) { ...existing insert... }`).

- [ ] **Step 2: Verify** `node --check server.js`; `npx vitest run` green.

- [ ] **Step 3: Manual reasoning check** (write into the commit body): non-conflict AHPRA emails still create `ahpra_correspondence`; only the conflict path routes to the single conflict-letter task.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: route officer conflict requests to the single conflict-letter task (suppress duplicate)" # + trailers
```

---

### Task 6: Auto-close matcher (practice→officer CC)

**Files:**
- Modify: `server.js` (inbound email pipeline — the same place `isConflictLetterConfirmation` inputs are available: sender, to, cc, message id)

**Implementation notes:**
- Early in the inbound handling (before/around the AHPRA-officer match block), for each case that has an `ahpra_officer_email` and an OPEN `ahpra_conflict_letter` task, test `isConflictLetterConfirmation(emailMeta, { practiceEmail, officerEmail })`.
- Practical match path: find the case by `ahpra_officer_email=eq.<officer in To/Cc>` (existing query pattern) AND verify `from === practice_email` of that case; or look up the open conflict-letter task's `metadata.practice_email`/`ahpra_officer_email` and test against the email.
- On match: `PUT` the task `status='completed'`, write a `task_message`/`task_document` record of the email (reuse existing helpers), stamp `metadata.confirmed_at` + `metadata.confirmed_via='practice_cc'`. Idempotent via the existing per-message dedup (`processed_gmail_messages` / `source_gmail_message_id`).

- [ ] **Step 1: Implement** the matcher + close.

- [ ] **Step 2: Verify** `node --check server.js`; `npx vitest run` green.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: auto-close conflict-letter task on practice→officer CC" # + trailers
```

---

### Task 7: Admin dashboard card (`pages/admin.html`)

**Files:**
- Modify: `pages/admin.html` (`_hasDetailPanel`; new `renderOpsAhpraConflictLetter`; dispatch in both the Ops Queue and GP-profile Tasks panes)

**Implementation notes:**
- Add `||t.task_type==='ahpra_conflict_letter'` to the `_hasDetailPanel` expression (so the row expands).
- Clone `renderOpsAltSupervisorCvRequest` → `renderOpsAhpraConflictLetter(task)`: status-gated. `open` → `.ops-email-composer` with `To` = `meta.practice_email`, Subject = `meta.suggested_subject`, body = `meta.suggested_body`, and a `data-ops-send-email` button with `data-ops-flip-status="waiting_on_practice"`. Add a small read-only line showing the officer it must reach: "Practice will email: {meta.ahpra_officer_name} ({meta.ahpra_officer_email}), CC {meta.cc_mailbox}". `waiting_on_practice` → "Sent — awaiting the practice to email AHPRA (they'll CC us)". `completed` → green "Confirmation received — on file".
- Add the `else if(tt==='ahpra_conflict_letter') h+=renderOpsAhpraConflictLetter(task);` dispatch in BOTH surfaces (mirror where `renderOpsAltSupervisorCvRequest` is dispatched).

- [ ] **Step 1: Implement** the three edits.

- [ ] **Step 2: Verify** the page parses: `node -e "require('fs').readFileSync('pages/admin.html','utf8')"` (sanity) and grep that the new symbol is referenced in both panes:
  `grep -c "renderOpsAhpraConflictLetter" pages/admin.html` → expect ≥ 3 (def + 2 dispatch).

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat: conflict-letter task card in admin dashboard" # + trailers
```

---

### Task 8: CEO dashboard parity (`pages/ceo-dashboard.html`)

**Files:**
- Modify: `pages/ceo-dashboard.html` (mirror Task 7)

- [ ] **Step 1: Implement** the same `_hasDetailPanel` entry (if present there), render fn, and dispatch, matching the CEO dashboard's existing alt-CV / ahpra rendering style.

- [ ] **Step 2: Verify** `grep -c "renderCeoAhpraConflictLetter\|ahpra_conflict_letter" pages/ceo-dashboard.html` → ≥ 2.

- [ ] **Step 3: Commit**

```bash
git add pages/ceo-dashboard.html
git commit -m "feat: conflict-letter task card in CEO dashboard (parity)" # + trailers
```

---

### Task 9: task_type constraint + full suite + deploy

**Files:**
- Create: `supabase/migrations/20260701000000_add_ahpra_conflict_letter_task_type.sql`

- [ ] **Step 1: Read the LIVE constraint** via `exec_sql` (service key from `.env`):
  `DO $$ BEGIN RAISE EXCEPTION '%', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='registration_tasks_task_type_check'); END $$;` → capture the current `task_type IN (...)` list from the 400 message.

- [ ] **Step 2: Write the migration** = the LIVE list UNION `'ahpra_conflict_letter'`:

```sql
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN ( /* <live list, verbatim> */ , 'ahpra_conflict_letter' ));
```

- [ ] **Step 3: Apply to prod** via `exec_sql` (same statements). Re-read the constraint to confirm `ahpra_conflict_letter` is present.

- [ ] **Step 4: Full verification:** `node --check server.js` clean; `npx vitest run` ALL green (≥ 851 + new tests).

- [ ] **Step 5: Commit + deploy:**

```bash
git add supabase/migrations/20260701000000_add_ahpra_conflict_letter_task_type.sql
git commit -m "chore: allow ahpra_conflict_letter task_type (constraint union)" # + trailers
GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push origin HEAD:main
```

- [ ] **Step 6: Verify deploy** READY (Vercel) and that an `ahpra_conflict_letter` row can be inserted (constraint live).

---

## Self-Review

**Spec coverage:** §4 triggers → Tasks 4 (A/B) + 5 (C). §5 task shape → Task 4. §6 dedup (lock + existence + suppression) → Tasks 4 + 5. §7 auto-close → Task 6. §9 email → Task 1. §10 UI → Tasks 7 + 8. §11 constraint → Task 9. §13 tests → Tasks 1-3 (+ suite gate in 4-9). All covered.

**Placeholder scan:** Tasks 1-3 contain complete code. Tasks 4-9 give concrete code/edits plus explicit anchor instructions (necessary because `server.js` is 45k lines and line numbers drift; the implementer reads the worktree to place them — this is an integration instruction, not a vague placeholder). The helper body has 3 inline `// resolve...` comments for the case/profile/practice lookups — the implementer copies these verbatim from `_ensureAltSupervisorCvRequest`, which is named as the exact source.

**Type consistency:** `buildConflictLetterEmail` / `isConflictLetterConfirmation` / `shouldEnsureConflictLetter` signatures match between lib definition (Tasks 1-3) and server usage (Tasks 4-6). `task_type='ahpra_conflict_letter'`, status flow `open→waiting_on_practice→completed`, and metadata keys are identical across Tasks 4, 7, 8.

**Note for executor:** Tasks 1-3 are independent (parallelizable). Tasks 4→5→6 are sequential (same `server.js` regions). Tasks 7, 8 are independent of 4-6. Task 9 is last (needs the new type live before prod inserts).
