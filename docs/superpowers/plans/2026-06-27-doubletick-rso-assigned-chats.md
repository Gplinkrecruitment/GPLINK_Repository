# DoubleTick RSO Assigned-Chats Auto-Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a GP is assigned to an RSO in GP Link, automatically assign that GP's WhatsApp chat to that RSO in DoubleTick, so each RSO (with a restricted DoubleTick role) only sees their own GPs plus unassigned general-inquiry chats.

**Architecture:** Add small pure helpers (phone resolution + request-body builder) plus thin fail-soft glue (`assignDoubleTickChat`, `syncCaseChatAssignment`, `getGpWhatsAppPhone`) in `server.js`, modelled exactly on the existing `sendDoubleTickTemplate` send code. Call `syncCaseChatAssignment` from the two case-PATCH endpoints that write `assigned_va`, plus a backstop in the inbound DoubleTick webhook. GP Link is the one-way source of truth; the DoubleTick-side role/invite setup is a separate owner runbook (Task 6).

**Tech Stack:** Node.js (vanilla `server.js`), `fetch`, Supabase REST (`supabaseDbRequest`), vitest.

## Global Constraints

- Reuse the proven DoubleTick auth/header convention exactly: `fetch(DOUBLETICK_BASE_URL + path, { method:'POST', headers:{ 'Authorization': DOUBLETICK_API_KEY, 'Content-Type':'application/json' }, signal })` with a 15s `AbortController` timeout. **No `Bearer` prefix.** (Pattern: `server.js` `sendDoubleTickTemplate`.)
- WABA / from-number is `HAZEL_WHATSAPP_NUMBER`, digits only: `String(HAZEL_WHATSAPP_NUMBER).replace(/[^\d]/g,'')`.
- Phone normalization is `normalizePhone()` (already in `server.js`); it returns `''` for empty/invalid.
- **Fail-soft, always.** No new code may throw into or block a case-save or webhook path. Every DoubleTick call is wrapped so failure is logged (prefix `[doubletick-assign]`) and swallowed.
- DoubleTick assign endpoint: `POST /team-member/assign`, body `{ customerPhoneNumber, assignedUserPhoneNumber, reassign:true, wabaNumber }`.
- One-way sync only (app → DoubleTick). Do NOT read DoubleTick assignments back into `assigned_va`.
- Cache busters / no behavioural changes to unrelated code. Run `node --check server.js` before every commit. Commit + push after each task (branch `worktree-doubletick-rso-assigned-chats`, push via `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes"`).
- Line numbers below are anchors from 2026-06-27; they may drift. **Locate edits by grepping the quoted anchor strings, not by line number.**

---

### Task 1: Pure helpers — RSO phone resolution + assign-body builder

**Files:**
- Modify: `server.js` (add two functions near the other DoubleTick send helpers; add two named exports next to `module.exports.mergeRsoRoster`)
- Test: `tests/doubletick-assign.test.js` (create)

**Interfaces:**
- Produces:
  - `findRsoPhoneInRoster(roster, rsoUserId) -> string` — normalized E.164 phone, or `''` if not found / no phone.
  - `buildDoubleTickAssignBody({ gpPhone, rsoPhone, wabaNumber }) -> object | null` — the `/team-member/assign` request body, or `null` if any required field is missing/empty after normalization.

- [ ] **Step 1: Write the failing test**

Create `tests/doubletick-assign.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { findRsoPhoneInRoster, buildDoubleTickAssignBody } from '../server.js';

const ROSTER = [
  { user_id: 'rso-khaleed', name: 'Khaleed', phone: '+61406281243', active: true },
  { user_id: 'rso-hazel', name: 'Hazel', phone: '', active: true },          // owner, no phone
  { user_id: 'rso-local', name: 'Local', phone: '0406281243', active: true } // AU local format
];

describe('findRsoPhoneInRoster', () => {
  it('returns the normalized phone for a matching RSO', () => {
    expect(findRsoPhoneInRoster(ROSTER, 'rso-khaleed')).toBe('+61406281243');
  });
  it('normalizes an AU local 04xx number to +61', () => {
    expect(findRsoPhoneInRoster(ROSTER, 'rso-local')).toBe('+61406281243');
  });
  it('returns empty string when the RSO has no phone (owner/archive)', () => {
    expect(findRsoPhoneInRoster(ROSTER, 'rso-hazel')).toBe('');
  });
  it('returns empty string when the RSO is not in the roster', () => {
    expect(findRsoPhoneInRoster(ROSTER, 'nope')).toBe('');
  });
  it('returns empty string for bad inputs', () => {
    expect(findRsoPhoneInRoster(null, 'rso-khaleed')).toBe('');
    expect(findRsoPhoneInRoster(ROSTER, '')).toBe('');
  });
});

describe('buildDoubleTickAssignBody', () => {
  it('builds the assign body with reassign:true and digits-only WABA', () => {
    expect(buildDoubleTickAssignBody({
      gpPhone: '+61400000001', rsoPhone: '+61406281243', wabaNumber: '+61494391968'
    })).toEqual({
      customerPhoneNumber: '+61400000001',
      assignedUserPhoneNumber: '+61406281243',
      reassign: true,
      wabaNumber: '61494391968'
    });
  });
  it('normalizes phones inside the builder', () => {
    const body = buildDoubleTickAssignBody({ gpPhone: '0400000001', rsoPhone: '0406281243', wabaNumber: '+61494391968' });
    expect(body.customerPhoneNumber).toBe('+61400000001');
    expect(body.assignedUserPhoneNumber).toBe('+61406281243');
  });
  it('returns null when GP phone is missing', () => {
    expect(buildDoubleTickAssignBody({ gpPhone: '', rsoPhone: '+61406281243', wabaNumber: '+61494391968' })).toBeNull();
  });
  it('returns null when RSO phone is missing', () => {
    expect(buildDoubleTickAssignBody({ gpPhone: '+61400000001', rsoPhone: '', wabaNumber: '+61494391968' })).toBeNull();
  });
  it('returns null when WABA number is missing', () => {
    expect(buildDoubleTickAssignBody({ gpPhone: '+61400000001', rsoPhone: '+61406281243', wabaNumber: '' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/doubletick-assign.test.js`
Expected: FAIL — `findRsoPhoneInRoster is not a function` / `buildDoubleTickAssignBody is not a function`.

- [ ] **Step 3: Add the two functions in `server.js`**

Insert immediately **before** `async function sendDoubleTickTemplate(` (grep anchor: `async function sendDoubleTickTemplate(toPhone, stage, gpFirstName)`):

```js
// ── DoubleTick chat-assignment helpers ──
// Pure (no DB/fetch) so they can be unit-tested. Resolve an RSO's WhatsApp
// phone from a roster (loadRsoTeam() output) and build the assign request body.
function findRsoPhoneInRoster(roster, rsoUserId) {
  if (!Array.isArray(roster) || !rsoUserId) return '';
  const match = roster.find(function (r) { return r && r.user_id === rsoUserId; });
  return match ? normalizePhone(match.phone || '') : '';
}

function buildDoubleTickAssignBody(opts) {
  const gpPhone = normalizePhone((opts && opts.gpPhone) || '');
  const rsoPhone = normalizePhone((opts && opts.rsoPhone) || '');
  const wabaNumber = String((opts && opts.wabaNumber) || '').replace(/[^\d]/g, '');
  if (!gpPhone || !rsoPhone || !wabaNumber) return null;
  return {
    customerPhoneNumber: gpPhone,
    assignedUserPhoneNumber: rsoPhone,
    reassign: true,
    wabaNumber: wabaNumber
  };
}
```

- [ ] **Step 4: Export the functions**

Find the export block (grep anchor: `module.exports.mergeRsoRoster = mergeRsoRoster;`) and add directly beneath it:

```js
module.exports.findRsoPhoneInRoster = findRsoPhoneInRoster;
module.exports.buildDoubleTickAssignBody = buildDoubleTickAssignBody;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/doubletick-assign.test.js`
Expected: PASS (11 assertions).

- [ ] **Step 6: Syntax check + commit**

```bash
node --check server.js
git add server.js tests/doubletick-assign.test.js
git commit -m "feat(doubletick): pure helpers for RSO chat-assignment (phone + body)"
```

---

### Task 2: Glue — assignDoubleTickChat, getGpWhatsAppPhone, syncCaseChatAssignment

**Files:**
- Modify: `server.js` (add three async functions after the pure helpers from Task 1)

**Interfaces:**
- Consumes: `findRsoPhoneInRoster`, `buildDoubleTickAssignBody` (Task 1); `loadRsoTeam`, `normalizePhone`, `isSupabaseDbConfigured`, `supabaseDbRequest`, `DOUBLETICK_API_KEY`, `DOUBLETICK_BASE_URL`, `HAZEL_WHATSAPP_NUMBER` (existing).
- Produces:
  - `async assignDoubleTickChat({ gpPhone, rsoPhone }) -> { ok, skipped?, status?, data?, error? }`
  - `async getGpWhatsAppPhone(userId) -> string` (normalized phone or `''`)
  - `async syncCaseChatAssignment({ gpPhone, assignedVaUserId }) -> { ok, skipped?, ... }`

> No new unit test in this task: the meaningful decisions are already covered by Task 1's pure-helper tests; these three are thin fail-soft I/O glue. The deliverable is gated by `node --check` + the full suite staying green. Live behaviour is confirmed in Task 6's manual verification (stated honestly — this glue is not auto-tested end-to-end).

- [ ] **Step 1: Add the glue functions in `server.js`**

Insert immediately **after** the `buildDoubleTickAssignBody` function added in Task 1 (and still before `sendDoubleTickTemplate`):

```js
// POST /team-member/assign — assign a GP's WhatsApp chat to an RSO in DoubleTick.
// Fail-soft: never throws; returns a result object. Mirrors the auth/timeout
// convention used by sendDoubleTickTemplate.
async function assignDoubleTickChat(opts) {
  if (!DOUBLETICK_API_KEY) {
    console.warn('[doubletick-assign] DOUBLETICK_API_KEY not set — skipping assign');
    return { ok: false, skipped: true };
  }
  const body = buildDoubleTickAssignBody({
    gpPhone: opts && opts.gpPhone,
    rsoPhone: opts && opts.rsoPhone,
    wabaNumber: HAZEL_WHATSAPP_NUMBER
  });
  if (!body) {
    console.warn('[doubletick-assign] Missing GP phone / RSO phone / WABA number — skipping assign');
    return { ok: false, skipped: true };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(DOUBLETICK_BASE_URL + '/team-member/assign', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': DOUBLETICK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    clearTimeout(timeout);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[doubletick-assign] API error:', resp.status, JSON.stringify(data).slice(0, 300));
      return { ok: false, status: resp.status, data: data };
    }
    console.log('[doubletick-assign] Assigned', body.customerPhoneNumber, '->', body.assignedUserPhoneNumber);
    return { ok: true, data: data };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[doubletick-assign] Error:', err && err.message);
    return { ok: false, error: err && err.message };
  }
}

// Resolve a GP's WhatsApp phone from their user_profiles row.
async function getGpWhatsAppPhone(userId) {
  if (!userId || !isSupabaseDbConfigured()) return '';
  try {
    const r = await supabaseDbRequest('user_profiles', 'select=phone,phone_number&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const p = (r && r.ok && Array.isArray(r.data) && r.data[0]) ? r.data[0] : null;
    return p ? normalizePhone(p.phone || p.phone_number || '') : '';
  } catch (err) {
    console.error('[doubletick-assign] getGpWhatsAppPhone error:', err && err.message);
    return '';
  }
}

// Orchestrator: given a GP phone and the assigned RSO's user_id, look up the
// RSO's WhatsApp phone from the live roster and assign the chat in DoubleTick.
// Skips silently (logged) for owner/archive RSOs or RSOs with no roster phone.
async function syncCaseChatAssignment(opts) {
  try {
    const gpPhone = normalizePhone((opts && opts.gpPhone) || '');
    const assignedVaUserId = (opts && opts.assignedVaUserId) || '';
    if (!gpPhone || !assignedVaUserId) return { ok: false, skipped: true };
    const roster = await loadRsoTeam({ includeInactive: true });
    const rsoPhone = findRsoPhoneInRoster(roster, assignedVaUserId);
    if (!rsoPhone) {
      console.warn('[doubletick-assign] No WhatsApp phone for RSO', assignedVaUserId, '— skipping chat assignment (owner/archive or missing roster phone)');
      return { ok: false, skipped: true };
    }
    return await assignDoubleTickChat({ gpPhone: gpPhone, rsoPhone: rsoPhone });
  } catch (err) {
    console.error('[doubletick-assign] syncCaseChatAssignment error:', err && err.message);
    return { ok: false, error: err && err.message };
  }
}
```

- [ ] **Step 2: Syntax check + full suite**

Run: `node --check server.js && npm test`
Expected: `node --check` clean; full vitest suite PASS (including Task 1's new tests). No existing test breaks.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(doubletick): fail-soft chat-assignment glue (assign + sync + gp phone)"
```

---

### Task 3: Wire auto-sync into the two case-PATCH endpoints

**Files:**
- Modify: `server.js` — the admin/RSO case PATCH and the CEO case PATCH

**Interfaces:**
- Consumes: `syncCaseChatAssignment`, `getGpWhatsAppPhone` (Task 2).

Both endpoints already `PATCH registration_cases ... { Prefer: 'return=representation' }` into a variable `r`, so `r.data[0]` is the full updated case row (includes `user_id`).

- [ ] **Step 1: Wire site A (admin/RSO PATCH)**

Grep anchor: `// Fetch old assigned_va before patching (needed for label reassignment)` — this block sets `oldAssignedVa`, then PATCHes into `r`, then logs the timeline. **After** the timeline-log block that starts `const changes = Object.keys(patch).filter(function (k) { return k !== 'last_va_action_at'; });` (the first occurrence, in this endpoint), insert:

```js
    // ── Auto-sync DoubleTick chat ownership to the newly-assigned RSO ──
    // Best-effort, one-way (GP Link is source of truth); never blocks the save.
    if (Object.prototype.hasOwnProperty.call(patch, 'assigned_va') && patch.assigned_va && patch.assigned_va !== oldAssignedVa) {
      try {
        const _dtCaseRow = (r.ok && Array.isArray(r.data) && r.data[0]) ? r.data[0] : null;
        const _dtUserId = _dtCaseRow ? _dtCaseRow.user_id : null;
        if (_dtUserId) {
          const _dtGpPhone = await getGpWhatsAppPhone(_dtUserId);
          if (_dtGpPhone) {
            await syncCaseChatAssignment({ gpPhone: _dtGpPhone, assignedVaUserId: patch.assigned_va });
          }
        }
      } catch (e) { console.error('[doubletick-assign] case PATCH sync (admin) failed:', e && e.message); }
    }
```

- [ ] **Step 2: Wire site B (CEO PATCH)**

Grep anchor (second case PATCH; near `'sponsor_name', 'sponsor_contact', 'migration_agent'` in its `allowed` array). **After** its timeline block `const changes = Object.keys(patch).filter(function (k) { return k !== 'last_va_action_at'; });` … `_logCaseEvent(...)` and **before** `sendJson(res, 200, { ok: true, case: ...`, insert:

```js
    // ── Auto-sync DoubleTick chat ownership to the assigned RSO (best-effort) ──
    if (Object.prototype.hasOwnProperty.call(patch, 'assigned_va') && patch.assigned_va) {
      try {
        const _dtCaseRow2 = (r.ok && Array.isArray(r.data) && r.data[0]) ? r.data[0] : null;
        const _dtUserId2 = _dtCaseRow2 ? _dtCaseRow2.user_id : null;
        if (_dtUserId2) {
          const _dtGpPhone2 = await getGpWhatsAppPhone(_dtUserId2);
          if (_dtGpPhone2) {
            await syncCaseChatAssignment({ gpPhone: _dtGpPhone2, assignedVaUserId: patch.assigned_va });
          }
        }
      } catch (e) { console.error('[doubletick-assign] case PATCH sync (ceo) failed:', e && e.message); }
    }
```

(Site B has no `oldAssignedVa` in scope; re-asserting with `reassign:true` is idempotent, so firing on every assigned_va write is safe.)

- [ ] **Step 3: Syntax check + full suite**

Run: `node --check server.js && npm test`
Expected: clean + all green.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(doubletick): auto-assign GP chat to RSO on case (re)assignment"
```

---

### Task 4: Webhook backstop — assign on inbound message for already-assigned cases

**Files:**
- Modify: `server.js` — `handleDoubleTickWebhook`

**Interfaces:**
- Consumes: `syncCaseChatAssignment` (Task 2).

- [ ] **Step 1: Include `assigned_va` in the active-case query**

Grep anchor: `'select=id,stage,substage,user_id&user_id=eq.' + encodeURIComponent(gpProfile.user_id) + '&status=not.eq.closed&order=created_at.desc&limit=1'`

Change `select=id,stage,substage,user_id` to `select=id,stage,substage,user_id,assigned_va` (only that one string).

- [ ] **Step 2: Add the backstop call**

Grep anchor: `if (activeCase) console.log('[doubletick-webhook] Created registration case for', gpProfile.user_id);` — this closes the "create case if missing" block. Immediately **after** that `if (...) { ... }` block, insert:

```js
    // Backstop: if this GP's case is already assigned to an RSO, make sure the
    // DoubleTick chat is owned by that RSO (closes the brief "unassigned, visible
    // to all" window on first inbound). Best-effort, fire-and-forget.
    if (activeCase && activeCase.assigned_va && fromPhone) {
      syncCaseChatAssignment({ gpPhone: fromPhone, assignedVaUserId: activeCase.assigned_va })
        .catch(function (e) { console.error('[doubletick-assign] webhook backstop failed:', e && e.message); });
    }
```

(`fromPhone` is the inbound sender, already defined earlier in the handler.)

- [ ] **Step 3: Syntax check + full suite**

Run: `node --check server.js && npm test`
Expected: clean + all green (existing `tests/doubletick-webhook.test.js` still passes).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(doubletick): webhook backstop re-asserts RSO chat ownership on inbound"
```

---

### Task 5: Owner runbook — DoubleTick role + invite setup

**Files:**
- Create: `docs/doubletick-rso-restricted-access-setup.md`

This is the config the owner performs in DoubleTick (no code). Capture it as a clear, plain-words runbook.

- [ ] **Step 1: Write the runbook**

Create `docs/doubletick-rso-restricted-access-setup.md`:

```markdown
# DoubleTick — restrict each RSO to their assigned GPs (+ unassigned inquiries)

**Plan required:** DoubleTick **Pro** (already active). Roles/permissions and the
Developer API are Pro-only.

## 1. Create the restricted role (once)
Settings → Manage Roles → create a **custom Channel role** named
`RSO – Assigned + Unassigned` on the GP Link WhatsApp number (+61494391968):

- View Assigned Chats — **ON**
- View Unassigned Chats — **ON**   (lets RSOs answer general inquiries)
- View All Chats — **OFF**          (hides other RSOs' GPs)
- Message Assigned Chats — **ON**
- Message Unassigned Chats — **ON**
- Start New Chats — **ON**
- Message All Chats — **OFF**, Delete Chats — **OFF**

Organization role: a non-admin "Team Member" (no invite/remove/settings powers).

## 2. Invite each RSO (per RSO)
Teams → Invite members → enter the RSO's **name + WhatsApp phone number** →
pick the org role + the `RSO – Assigned + Unassigned` channel role → Invite.
The RSO accepts on WhatsApp and logs in **with that exact phone number**.

## 3. Record each RSO's phone in GP Link
The app routes chats by matching the GP's assigned RSO to that RSO's phone in the
`rso_team` table. For every active RSO, make sure `rso_team.phone` holds the **same
WhatsApp number** they were invited with (E.164, e.g. +61406281243). RSOs with a
blank phone (owner/archive) are skipped by design — they see everything anyway.

## 4. How it stays in sync (automatic)
Whenever you set/change a GP's assigned RSO in the GP Link dashboard, the app calls
DoubleTick to assign that GP's chat to that RSO. New/unassigned GPs stay visible to
all RSOs until someone picks them up (first responder owns it). Non-GP inbound that
nobody owns is also visible to all RSOs — claim it yourself (assign to you, the
Owner) to hide it. This is the accepted v1 behaviour.

## 5. Verify
- Assign a test GP to RSO-A → confirm only RSO-A sees that chat.
- Confirm RSO-A also sees an unassigned chat, and RSO-B does NOT see RSO-A's GP.
- Reassign the GP to RSO-B → confirm the chat moves.
```

- [ ] **Step 2: Commit**

```bash
git add docs/doubletick-rso-restricted-access-setup.md
git commit -m "docs(doubletick): owner runbook for restricted RSO access"
```

---

### Task 6: Final verification + push

- [ ] **Step 1: Full gate**

Run: `node --check server.js && npm test`
Expected: `node --check` clean; entire vitest suite green.

- [ ] **Step 2: Confirm roster phones (data prerequisite)**

Confirm every **active** RSO in `rso_team` who should receive chats has a `phone`
matching their DoubleTick-login number. If any active RSO has a blank/old phone,
flag it to the owner (it's the only thing that silently disables routing for that
RSO). This is a data check, not code — report findings honestly.

- [ ] **Step 3: Push the branch**

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push -u origin worktree-doubletick-rso-assigned-chats
```

- [ ] **Step 4: Manual live verification (state honestly as manual)**

Follow `docs/doubletick-rso-restricted-access-setup.md` §5 against the live
DoubleTick workspace. Report exactly what was observed; do not claim the live wall
works until it's been seen working.

---

## Self-review

**Spec coverage:**
- Req 1 (RSO sees/messages own GPs): Task 5 role (View Assigned ON) + Task 3/4 auto-assign. ✓
- Req 2 (RSO sees/messages unassigned inquiries): Task 5 role (View Unassigned ON). ✓
- Req 3 (RSO can't see other RSO's GPs): Task 5 role (View All OFF). ✓
- Req 4 (auto-assign on assignment change, overriding): Task 2 `reassign:true` + Task 3 wiring + Task 4 backstop. ✓
- Req 5 (owner unaffected): owner has no roster phone → `findRsoPhoneInRoster` returns '' → skipped; Owner role sees all. ✓
- Non-goal (one-way): no read-back code anywhere. ✓
- Non-goal (no contact-type filtering): documented as accepted v1 in Task 5. ✓
- Edge: missing RSO phone → skip+log (Task 2). GP no phone → skip (Task 2/3). Owner/archive → skip (Task 2). ✓
- Data prerequisite (rso_team phone): Task 6 Step 2. ✓ (`rso_team.phone` column already exists — no migration.)

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `findRsoPhoneInRoster`/`buildDoubleTickAssignBody`/`assignDoubleTickChat`/`getGpWhatsAppPhone`/`syncCaseChatAssignment` names + signatures are used identically across Tasks 1–4. Roster objects use `user_id`/`phone` (matches `loadRsoTeam`/`mergeRsoRoster` output). Assign body keys match the DoubleTick `/team-member/assign` contract.
```
