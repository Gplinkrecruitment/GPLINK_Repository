# Registration Email Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all GP/practice document-request email through a single central `registration@mygplink.com.au` mailbox that shows the assigned RSO's name, and give RSOs a unified Inbox of every conversation, while replies still auto-file to the right case.

**Architecture:** Outbound sender selection moves into a small pure module (`lib/registration-hub.js`) and is gated by a single env var `REGISTRATION_HUB_EMAIL`. When that var is empty (the default, and the only state until the mailbox exists) behaviour is **identical to today** (per-RSO sender). When set, every case email sends from the hub mailbox with the RSO's display name, the hub mailbox is added to the watched-inbox set so replies are processed by the existing thread-matcher, and a new Inbox UI in `admin.html` lists conversations grouped by case (reading the existing `task_messages` data plus one new `read_at` column).

**Tech Stack:** Node (monolith `server.js`), Gmail API (domain-wide delegation), Supabase Postgres (+ local JSON db fallback), vanilla JS/HTML (`pages/admin.html`), vitest.

## Global Constraints

- **Non-destructive by default.** `REGISTRATION_HUB_EMAIL` defaults to `''`; with it empty, outbound and inbound behaviour MUST be byte-for-byte the current behaviour. No live behaviour changes until the operator sets the var.
- **Sender domain rule:** outbound `from` must always be an `@mygplink.com.au` address (Gmail domain-wide delegation only works for those). Verbatim regex used today: `/@mygplink\.com\.au$/`.
- **Display name copy:** hub emails show `"<RSO name> — GP Link"`; when no RSO name is known, fall back to the current literal `"GP Link Registration"`.
- **Reply threading is by `gmail_thread_id`** — never break the existing thread-matcher in `processGmailNotification()`.
- **Cache-buster convention:** bumping any `<script>` in `admin.html` uses `?v=YYYYMMDD[letter]` (e.g. `?v=20260627a`).
- **Test command:** `npx vitest run` must stay fully green (baseline 671 passing). Single file: `npx vitest run tests/<file>.test.js`.
- **Sanity gate before any commit that touches server.js:** `node --check server.js`.
- **Branch:** preview only (`worktree-rso-email-hub-prototype`). Do NOT merge to main until the operator has set up the mailbox and signed off.

---

### Task 1: Pure sender/inbox-gating module

**Files:**
- Create: `lib/registration-hub.js`
- Test: `tests/registration-hub.test.js`

**Interfaces:**
- Produces:
  - `buildSenderDisplayName(rsoName: string|null): string`
  - `resolveSender({ hubEmail, rsoEmail, rsoName, fallback }): { from: string, fromName: string }`
  - `isHubInbox(email: string, hubEmail: string): boolean`

- [ ] **Step 1: Write the failing test**

```js
// tests/registration-hub.test.js
import { describe, it, expect } from 'vitest';
import pkg from '../lib/registration-hub.js';
const { buildSenderDisplayName, resolveSender, isHubInbox } = pkg;

describe('buildSenderDisplayName', () => {
  it('appends the GP Link suffix when a name is given', () => {
    expect(buildSenderDisplayName('Hazel')).toBe('Hazel — GP Link');
    expect(buildSenderDisplayName('  Smith Miller ')).toBe('Smith Miller — GP Link');
  });
  it('falls back to the generic name when empty/null', () => {
    expect(buildSenderDisplayName('')).toBe('GP Link Registration');
    expect(buildSenderDisplayName(null)).toBe('GP Link Registration');
  });
});

describe('resolveSender', () => {
  it('hub OFF → current per-RSO behaviour (RSO mailbox + generic name)', () => {
    expect(resolveSender({ hubEmail: '', rsoEmail: 'hazel@mygplink.com.au', rsoName: 'Hazel', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'hazel@mygplink.com.au', fromName: 'GP Link Registration' });
  });
  it('hub OFF + non-mygplink RSO email → fallback mailbox', () => {
    expect(resolveSender({ hubEmail: '', rsoEmail: 'someone@gmail.com', rsoName: 'X', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'hazel@mygplink.com.au', fromName: 'GP Link Registration' });
  });
  it('hub ON → hub mailbox + RSO display name', () => {
    expect(resolveSender({ hubEmail: 'registration@mygplink.com.au', rsoEmail: 'hazel@mygplink.com.au', rsoName: 'Hazel', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'registration@mygplink.com.au', fromName: 'Hazel — GP Link' });
  });
  it('hub ON + no RSO name → hub mailbox + generic name', () => {
    expect(resolveSender({ hubEmail: 'registration@mygplink.com.au', rsoEmail: '', rsoName: '', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'registration@mygplink.com.au', fromName: 'GP Link Registration' });
  });
});

describe('isHubInbox', () => {
  it('true only for the hub address (case-insensitive) when hub is set', () => {
    expect(isHubInbox('Registration@MyGPLink.com.au', 'registration@mygplink.com.au')).toBe(true);
    expect(isHubInbox('hazel@mygplink.com.au', 'registration@mygplink.com.au')).toBe(false);
  });
  it('false when hub is off', () => {
    expect(isHubInbox('registration@mygplink.com.au', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/registration-hub.test.js`
Expected: FAIL — `Cannot find module '../lib/registration-hub.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/registration-hub.js
'use strict';

function buildSenderDisplayName(rsoName) {
  var name = (rsoName == null ? '' : String(rsoName)).trim();
  return name ? name + ' — GP Link' : 'GP Link Registration';
}

function resolveSender(opts) {
  opts = opts || {};
  var hubEmail = String(opts.hubEmail || '').trim().toLowerCase();
  var rsoEmail = String(opts.rsoEmail || '').trim().toLowerCase();
  var fallback = String(opts.fallback || 'hazel@mygplink.com.au').trim().toLowerCase();
  if (hubEmail) {
    return { from: hubEmail, fromName: buildSenderDisplayName(opts.rsoName) };
  }
  var from = /@mygplink\.com\.au$/.test(rsoEmail) ? rsoEmail : fallback;
  return { from: from, fromName: 'GP Link Registration' };
}

function isHubInbox(email, hubEmail) {
  if (!hubEmail) return false;
  return String(email || '').trim().toLowerCase() === String(hubEmail).trim().toLowerCase();
}

module.exports = { buildSenderDisplayName, resolveSender, isHubInbox };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/registration-hub.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/registration-hub.js tests/registration-hub.test.js
git commit -m "feat(hub): pure sender/inbox-gating helpers for registration email hub"
```

---

### Task 2: Add `fromName` to `sendGmailEmail`

**Files:**
- Modify: `server.js` (function `sendGmailEmail`, ~lines 1783–1929; the `From:` header is at ~line 1810)
- Test: `tests/registration-hub.test.js` (extend — assert the header-building contract via a tiny exported helper)

**Interfaces:**
- Consumes: `buildSenderDisplayName` (Task 1) is NOT imported here; instead `sendGmailEmail` gains an optional `fromName` param.
- Produces: `sendGmailEmail({ from, fromName, to, cc, subject, bodyHtml, bodyText, attachments, threadId, inReplyTo })` — `fromName` optional; when omitted the header is unchanged (`"GP Link Registration"`).

Because `sendGmailEmail` is an internal monolith function that performs network I/O, extract the one pure line (header construction) into `lib/registration-hub.js` so it is unit-testable, then call it from `server.js`.

- [ ] **Step 1: Write the failing test (extend Task 1 file)**

```js
// append to tests/registration-hub.test.js
import pkg2 from '../lib/registration-hub.js';
const { buildFromHeader } = pkg2;

describe('buildFromHeader', () => {
  it('uses the provided display name', () => {
    expect(buildFromHeader('Hazel — GP Link', 'registration@mygplink.com.au'))
      .toBe('From: "Hazel — GP Link" <registration@mygplink.com.au>');
  });
  it('defaults to GP Link Registration when no name', () => {
    expect(buildFromHeader('', 'hazel@mygplink.com.au'))
      .toBe('From: "GP Link Registration" <hazel@mygplink.com.au>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/registration-hub.test.js`
Expected: FAIL — `buildFromHeader is not a function`.

- [ ] **Step 3: Implement `buildFromHeader` and export it**

Add to `lib/registration-hub.js` (before `module.exports`):

```js
function buildFromHeader(fromName, fromEmail) {
  var name = String(fromName || '').trim() || 'GP Link Registration';
  return 'From: "' + name + '" <' + fromEmail + '>';
}
```

Add `buildFromHeader` to the `module.exports` object.

- [ ] **Step 4: Wire it into `server.js`**

At the top of `server.js` where other `lib/` modules are required, add (match existing require style):

```js
const registrationHub = require('./lib/registration-hub.js');
const REGISTRATION_HUB_EMAIL = String(process.env.REGISTRATION_HUB_EMAIL || '').trim().toLowerCase();
```

In `sendGmailEmail`, change the signature destructure to include `fromName`, and replace the hard-coded From header (~line 1810):

```js
// BEFORE:
//   headers.push('From: "GP Link Registration" <' + from + '>');
// AFTER:
headers.push(registrationHub.buildFromHeader(fromName, from));
```

- [ ] **Step 5: Run tests + sanity check**

Run: `npx vitest run tests/registration-hub.test.js` → Expected: PASS
Run: `node --check server.js` → Expected: no output (valid syntax)

- [ ] **Step 6: Commit**

```bash
git add lib/registration-hub.js tests/registration-hub.test.js server.js
git commit -m "feat(hub): sendGmailEmail accepts fromName; header built via lib helper"
```

---

### Task 3: Hub-aware sender resolution at all case-email send sites

**Files:**
- Modify: `server.js` — add `resolveCaseSenderName()` and `resolveCaseSenderInfo()` near `resolveCaseSenderEmail` (~lines 1931–1950); update the send call sites: `/api/admin/email/send` (~25259–25280) and the four other case sends (~35103, ~35242, ~35924, ~35977).
- Test: `tests/registration-hub.test.js` (the routing decision is already covered by `resolveSender`; this task is wiring).

**Interfaces:**
- Consumes: `registrationHub.resolveSender` (Task 1), `REGISTRATION_HUB_EMAIL` (Task 2), existing `resolveCaseSenderEmail`, `resolveCaseRsoAssignee`, `loadRsoTeam`, `MONITORED_VA_EMAILS`.
- Produces: `resolveCaseSenderInfo(caseId, knownAssignedVa?): Promise<{ from, fromName }>` — the single source of truth for "who is this email from". Every case email send site calls it.

- [ ] **Step 1: Add `resolveCaseSenderName` and `resolveCaseSenderInfo`**

Immediately after `resolveCaseSenderEmail` in `server.js`:

```js
// Display name of the case's assigned RSO (empty string if none / not on roster).
async function resolveCaseSenderName(caseId, knownAssignedVa) {
  if (!caseId) return '';
  try {
    var rsoUserId = await resolveCaseRsoAssignee(caseId, knownAssignedVa);
    if (!rsoUserId) return '';
    var roster = await loadRsoTeam({ includeInactive: true });
    var rso = (roster || []).find(function (r) { return r.user_id === rsoUserId; });
    return (rso && rso.name) ? String(rso.name).trim() : '';
  } catch (e) { return ''; }
}

// Single source of truth for the From address + display name of a case email.
// Hub OFF → per-RSO mailbox + generic name (unchanged). Hub ON → hub mailbox + RSO name.
async function resolveCaseSenderInfo(caseId, knownAssignedVa) {
  var rsoEmail = await resolveCaseSenderEmail(caseId, knownAssignedVa);
  var rsoName = await resolveCaseSenderName(caseId, knownAssignedVa);
  return registrationHub.resolveSender({
    hubEmail: REGISTRATION_HUB_EMAIL,
    rsoEmail: rsoEmail,
    rsoName: rsoName,
    fallback: MONITORED_VA_EMAILS[0] || 'hazel@mygplink.com.au'
  });
}
```

- [ ] **Step 2: Update `/api/admin/email/send` (~line 25259–25280)**

Replace the `var senderEmail = await resolveCaseSenderEmail(senderCaseId);` block and the `sendGmailEmail({ from: senderEmail, ... })` call:

```js
var senderInfo = await resolveCaseSenderInfo(senderCaseId);
// ...
var sendResult = await sendGmailEmail({
  from: senderInfo.from,
  fromName: senderInfo.fromName,
  to: emailTo,
  cc: emailCc,
  subject: emailSubject,
  bodyHtml: emailBodyHtml,
  bodyText: emailBodyText,
  attachments: resolvedAttachments.length > 0 ? resolvedAttachments : null,
  threadId: emailThreadId,
  inReplyTo: emailInReplyTo
});
```

- [ ] **Step 3: Update the four other case send sites**

At each of ~35103, ~35242, ~35924, ~35977, wherever the code does `resolveCaseSenderEmail(<caseId>)` and passes `from:` to `sendGmailEmail`, replace with:

```js
var _si = await resolveCaseSenderInfo(<caseId>);
// then in the sendGmailEmail call: from: _si.from, fromName: _si.fromName,
```

Use a distinct local var name per site (`_siAhpra`, `_siPractice`, etc.) to avoid redeclare collisions. Do NOT change any site that is a system/notification email not tied to a case (those keep their current `from`).

- [ ] **Step 4: Sanity check + full suite**

Run: `node --check server.js` → Expected: clean
Run: `npx vitest run` → Expected: full green (hub off = unchanged behaviour, so no existing test should move).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(hub): route all case email sends through resolveCaseSenderInfo (hub-aware)"
```

---

### Task 4: Inbound — watch the hub mailbox + add `read_at` column

**Files:**
- Create: `supabase/migrations/20260627000000_task_messages_read_at.sql`
- Modify: `server.js` — config block (~1700–1726) to include the hub mailbox in `MONITORED_VA_EMAILS` and exclude it from `NEVER_PROCESS_EMAILS` when `REGISTRATION_HUB_EMAIL` is set.
- Test: `tests/registration-hub.test.js` already covers `isHubInbox`; add a config-shape assertion is unnecessary (config runs at import). This task is migration + a guarded config tweak.

**Interfaces:**
- Consumes: `REGISTRATION_HUB_EMAIL`, `registrationHub.isHubInbox`.
- Produces: when the hub var is set, `MONITORED_VA_EMAILS` contains the hub address and `NEVER_PROCESS_EMAILS` does not — so the existing `processGmailNotification()` thread-matcher processes hub replies with zero further changes. New DB column `task_messages.read_at TIMESTAMPTZ`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260627000000_task_messages_read_at.sql
-- Unread tracking for the Registration Inbox. Null = unread (inbound only).
ALTER TABLE task_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_task_messages_unread
  ON task_messages (case_id)
  WHERE direction = 'inbound' AND read_at IS NULL;
```

- [ ] **Step 2: Guard the config block (server.js ~1700–1726)**

Immediately after `MONITORED_VA_EMAILS` and `NEVER_PROCESS_EMAILS` are defined, append:

```js
// When the registration hub mailbox is configured, it must be watched + processed.
if (REGISTRATION_HUB_EMAIL) {
  NEVER_PROCESS_EMAILS.delete(REGISTRATION_HUB_EMAIL);
  if (!MONITORED_VA_EMAILS.includes(REGISTRATION_HUB_EMAIL)) {
    MONITORED_VA_EMAILS.push(REGISTRATION_HUB_EMAIL);
  }
}
```

(`REGISTRATION_HUB_EMAIL` is declared in Task 2; ensure that declaration sits ABOVE this block. If the existing `const`s use a different mutable form, adapt: `NEVER_PROCESS_EMAILS` is a `Set` — `.delete` is valid; `MONITORED_VA_EMAILS` is an array — `.push` is valid.)

- [ ] **Step 3: Sanity check + suite**

Run: `node --check server.js` → clean
Run: `npx vitest run` → full green (hub off → block is a no-op).

- [ ] **Step 4: Commit**

```bash
git add server.js supabase/migrations/20260627000000_task_messages_read_at.sql
git commit -m "feat(hub): watch hub mailbox when configured; add task_messages.read_at"
```

---

### Task 5: Conversation-grouping logic + `/api/admin/inbox/conversations`

**Files:**
- Create: `lib/registration-hub-inbox.js`
- Modify: `server.js` — add `GET /api/admin/inbox/conversations` near the other `/api/admin/*` inbox endpoints (after `renderInboxPanel`'s server feeders, e.g. near ~33475 where `/api/admin/task/messages` lives).
- Test: `tests/registration-hub-inbox.test.js`

**Interfaces:**
- Produces:
  - `groupConversations({ messages, casesById, rsoNameByUserId, scope, meUserId }): Array<Conversation>`
  - `Conversation = { caseId, name, kind, stage, assignedVa, assignedRsoName, lastMessageAt, lastPreview, lastDirection, needsReply, unread }`
  - Endpoint `GET /api/admin/inbox/conversations?scope=mine|all` → `{ ok: true, conversations: Conversation[] }`

- [ ] **Step 1: Write the failing test**

```js
// tests/registration-hub-inbox.test.js
import { describe, it, expect } from 'vitest';
import pkg from '../lib/registration-hub-inbox.js';
const { groupConversations } = pkg;

const casesById = {
  c1: { id: 'c1', stage: 'ahpra', assigned_va: 'u-hazel', gp_name: 'Dr Sana Khan', practice_name: null },
  c2: { id: 'c2', stage: 'practice_contact', assigned_va: 'u-smith', gp_name: 'Dr Ade Okonkwo', practice_name: 'Greenslopes' }
};
const rsoNameByUserId = { 'u-hazel': 'Hazel', 'u-smith': 'Smith Miller' };
const messages = [
  { case_id: 'c1', direction: 'outbound', subject: 'AHPRA docs', body_text: 'Hi Sana...', created_at: '2026-06-12T09:14:00Z', read_at: null },
  { case_id: 'c1', direction: 'inbound', subject: 'Re: AHPRA docs', body_text: 'Thanks Hazel', created_at: '2026-06-12T16:02:00Z', read_at: null },
  { case_id: 'c2', direction: 'outbound', subject: 'Welcome', body_text: 'Hi Ade', created_at: '2026-06-24T11:20:00Z', read_at: '2026-06-24T12:00:00Z' }
];

describe('groupConversations', () => {
  it('one row per case, newest-message summary, needsReply from last direction', () => {
    const out = groupConversations({ messages, casesById, rsoNameByUserId, scope: 'all', meUserId: 'u-hazel' });
    const c1 = out.find(x => x.caseId === 'c1');
    expect(c1.name).toBe('Dr Sana Khan');
    expect(c1.assignedRsoName).toBe('Hazel');
    expect(c1.lastDirection).toBe('inbound');
    expect(c1.needsReply).toBe(true);
    expect(c1.unread).toBe(true);          // an inbound message with read_at null
    expect(c1.lastPreview).toContain('Thanks Hazel');
  });
  it('scope=mine filters to the current user\'s cases', () => {
    const mine = groupConversations({ messages, casesById, rsoNameByUserId, scope: 'mine', meUserId: 'u-hazel' });
    expect(mine.map(x => x.caseId)).toEqual(['c1']);
  });
  it('sorts newest conversation first', () => {
    const all = groupConversations({ messages, casesById, rsoNameByUserId, scope: 'all', meUserId: 'u-hazel' });
    expect(all[0].caseId).toBe('c2'); // c2 last activity 24 Jun > c1 12 Jun
  });
  it('uses practice name + practice kind when present', () => {
    const all = groupConversations({ messages, casesById, rsoNameByUserId, scope: 'all', meUserId: 'u-hazel' });
    const c2 = all.find(x => x.caseId === 'c2');
    expect(c2.kind).toBe('practice');
    expect(c2.name).toBe('Greenslopes');
    expect(c2.unread).toBe(false); // its inbound (none here) — last msg outbound + read
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/registration-hub-inbox.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```js
// lib/registration-hub-inbox.js
'use strict';

function previewOf(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

function groupConversations(opts) {
  opts = opts || {};
  var messages = opts.messages || [];
  var casesById = opts.casesById || {};
  var rsoNameByUserId = opts.rsoNameByUserId || {};
  var scope = opts.scope === 'mine' ? 'mine' : 'all';
  var meUserId = opts.meUserId || null;

  var byCase = {};
  messages.forEach(function (m) {
    var cid = m.case_id;
    if (!cid || !casesById[cid]) return;
    if (!byCase[cid]) byCase[cid] = { caseId: cid, last: null, unread: false };
    var g = byCase[cid];
    if (!g.last || new Date(m.created_at) >= new Date(g.last.created_at)) g.last = m;
    if (m.direction === 'inbound' && !m.read_at) g.unread = true;
  });

  var out = Object.keys(byCase).map(function (cid) {
    var g = byCase[cid];
    var c = casesById[cid];
    var isPractice = !!(c.practice_name && String(c.practice_name).trim());
    return {
      caseId: cid,
      name: isPractice ? c.practice_name : (c.gp_name || 'Unknown'),
      kind: isPractice ? 'practice' : 'doctor',
      stage: c.stage || '',
      assignedVa: c.assigned_va || null,
      assignedRsoName: rsoNameByUserId[c.assigned_va] || '',
      lastMessageAt: g.last ? g.last.created_at : null,
      lastPreview: g.last ? previewOf(g.last.body_text || g.last.subject) : '',
      lastDirection: g.last ? g.last.direction : null,
      needsReply: g.last ? g.last.direction === 'inbound' : false,
      unread: g.unread
    };
  });

  if (scope === 'mine' && meUserId) {
    out = out.filter(function (x) { return x.assignedVa === meUserId; });
  }
  out.sort(function (a, b) {
    return new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0);
  });
  return out;
}

module.exports = { groupConversations, previewOf };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/registration-hub-inbox.test.js` → Expected: PASS.

- [ ] **Step 5: Add the endpoint in server.js**

Near the other admin inbox endpoints (model the auth guard + `supabaseDbRequest` usage on the existing `GET /api/admin/task/messages` at ~33475):

```js
// GET /api/admin/inbox/conversations?scope=mine|all
if (pathname === '/api/admin/inbox/conversations' && req.method === 'GET') {
  var adminUser = await requireAdmin(req, res); if (!adminUser) return; // match existing guard helper
  var scope = (url.searchParams.get('scope') === 'all') ? 'all' : 'mine';
  // recent email messages (cap 1000), their cases, and the RSO roster
  var msgRes = await supabaseDbRequest('task_messages',
    'select=case_id,direction,subject,body_text,created_at,read_at&channel=eq.email&order=created_at.desc&limit=1000');
  var msgs = (msgRes.ok && Array.isArray(msgRes.data)) ? msgRes.data : [];
  var caseIds = Array.from(new Set(msgs.map(function (m) { return m.case_id; }).filter(Boolean)));
  var casesById = {};
  if (caseIds.length) {
    var inList = caseIds.map(encodeURIComponent).join(',');
    var cRes = await supabaseDbRequest('registration_cases',
      'select=id,stage,assigned_va,practice_name,user_id&id=in.(' + inList + ')');
    (cRes.ok && Array.isArray(cRes.data) ? cRes.data : []).forEach(function (c) { casesById[c.id] = c; });
    // enrich gp_name from user_profiles (reuse existing helper if present, else minimal lookup)
    await _attachGpNames(casesById); // implement inline if no helper exists (see note)
  }
  var roster = await loadRsoTeam({ includeInactive: true });
  var rsoNameByUserId = {};
  (roster || []).forEach(function (r) { rsoNameByUserId[r.user_id] = r.name; });
  var conversations = registrationHubInbox.groupConversations({
    messages: msgs, casesById: casesById, rsoNameByUserId: rsoNameByUserId,
    scope: scope, meUserId: adminUser.user_id
  });
  return sendJson(res, 200, { ok: true, conversations: conversations });
}
```

Notes for the implementer:
- Require the module at top of server.js: `const registrationHubInbox = require('./lib/registration-hub-inbox.js');`
- `requireAdmin`, `sendJson`, `supabaseDbRequest`, `loadRsoTeam` already exist — match their exact names/usage from the neighbouring endpoint you are pasting beside (read 20 lines around `/api/admin/task/messages`).
- `_attachGpNames`: if an existing helper already enriches a case map with `gp_name` (the `/api/admin/case` endpoint does this — reuse that exact code), call it; otherwise fetch `user_profiles` by the cases' `user_id`s and set `casesById[id].gp_name`. Keep it to one batched query.

- [ ] **Step 6: Sanity + commit**

Run: `node --check server.js` → clean; `npx vitest run tests/registration-hub-inbox.test.js` → PASS

```bash
git add lib/registration-hub-inbox.js tests/registration-hub-inbox.test.js server.js
git commit -m "feat(hub): conversation grouping + GET /api/admin/inbox/conversations"
```

---

### Task 6: Thread read endpoint + mark-read endpoint

**Files:**
- Modify: `server.js` — add `GET /api/admin/inbox/thread` and `POST /api/admin/inbox/mark-read` beside Task 5's endpoint.
- Test: `tests/registration-hub-inbox.test.js` — add a pure helper `threadHeader(case, rsoName)` if any shaping logic is non-trivial; otherwise these are thin DB endpoints validated by the smoke suite.

**Interfaces:**
- Produces:
  - `GET /api/admin/inbox/thread?caseId={id}` → `{ ok, header: { caseId, name, kind, stage, assignedVa, assignedRsoName }, messages: TaskMessage[] }` (messages ascending by `created_at`).
  - `POST /api/admin/inbox/mark-read` body `{ caseId }` → `{ ok: true, updated: <n> }` (sets `read_at=now()` on that case's unread inbound email messages).

- [ ] **Step 1: Add the thread endpoint**

```js
// GET /api/admin/inbox/thread?caseId=...
if (pathname === '/api/admin/inbox/thread' && req.method === 'GET') {
  var au = await requireAdmin(req, res); if (!au) return;
  var caseId = url.searchParams.get('caseId');
  if (!caseId) return sendJson(res, 400, { ok: false, error: 'caseId required' });
  var cRes = await supabaseDbRequest('registration_cases',
    'select=id,stage,assigned_va,practice_name,user_id&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
  var c = (cRes.ok && Array.isArray(cRes.data) && cRes.data[0]) ? cRes.data[0] : null;
  if (!c) return sendJson(res, 404, { ok: false, error: 'case not found' });
  var oneCase = {}; oneCase[c.id] = c; await _attachGpNames(oneCase); c = oneCase[c.id];
  var mRes = await supabaseDbRequest('task_messages',
    'select=id,direction,channel,sender,recipient,subject,body_text,attachments,created_at,read_at,gmail_thread_id&case_id=eq.' +
    encodeURIComponent(caseId) + '&channel=eq.email&order=created_at.asc&limit=500');
  var roster = await loadRsoTeam({ includeInactive: true });
  var rso = (roster || []).find(function (r) { return r.user_id === c.assigned_va; });
  var isPractice = !!(c.practice_name && String(c.practice_name).trim());
  return sendJson(res, 200, {
    ok: true,
    header: {
      caseId: c.id, name: isPractice ? c.practice_name : (c.gp_name || 'Unknown'),
      kind: isPractice ? 'practice' : 'doctor', stage: c.stage || '',
      assignedVa: c.assigned_va || null, assignedRsoName: rso ? rso.name : ''
    },
    messages: (mRes.ok && Array.isArray(mRes.data)) ? mRes.data : []
  });
}
```

- [ ] **Step 2: Add the mark-read endpoint**

```js
// POST /api/admin/inbox/mark-read  { caseId }
if (pathname === '/api/admin/inbox/mark-read' && req.method === 'POST') {
  var au2 = await requireAdmin(req, res); if (!au2) return;
  var body = await readJsonBody(req); // reuse existing body parser used by neighbouring POSTs
  var cid = body && body.caseId;
  if (!cid) return sendJson(res, 400, { ok: false, error: 'caseId required' });
  var upd = await supabaseDbRequest('task_messages',
    'case_id=eq.' + encodeURIComponent(cid) + '&direction=eq.inbound&read_at=is.null',
    { method: 'PATCH', body: { read_at: new Date().toISOString() } }); // match existing PATCH signature
  return sendJson(res, 200, { ok: true, updated: (upd.ok && Array.isArray(upd.data)) ? upd.data.length : 0 });
}
```

Implementer note: copy the exact `supabaseDbRequest` PATCH calling convention from an existing update site (e.g. the reassignment write at ~32239) — argument order and how the filter/body are passed must match that helper's real signature.

- [ ] **Step 3: Sanity + full suite**

Run: `node --check server.js` → clean
Run: `npx vitest run` → full green.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(hub): inbox thread + mark-read endpoints"
```

---

### Task 7: Admin Inbox UI (tab + conversation list + thread + composer)

**Files:**
- Modify: `pages/admin.html` — add an "Inbox" entry to the tab bar (~lines 1316–1325), a `#hubInboxPanel` container, and the rendering JS inside the main script block (1534–10115). Bump the page cache-buster.
- Test: visual — headless Chrome screenshot (no automated UI test in this repo for admin.html; the smoke suite covers endpoints).

**Interfaces:**
- Consumes: `GET /api/admin/inbox/conversations`, `GET /api/admin/inbox/thread`, `POST /api/admin/inbox/mark-read`, and the existing `POST /api/admin/email/send` for replies.
- Produces: a working Inbox tab. Reuse the visual structure already validated in `pages/rso-email-prototype.html` (conversation rows, thread bubbles, composer).

- [ ] **Step 1: Add the tab + panel**

In the tab bar (~1316–1325) add, matching the existing tab markup:

```html
<button class="view-tab" data-view="hubInbox">Inbox</button>
```

After the existing `#inboxPanel` (~line 1339) add:

```html
<div id="hubInboxPanel" style="display:none"></div>
```

- [ ] **Step 2: Add the renderer JS (inside the main script block)**

Port the prototype's render/JS (already written and screenshot-verified in `pages/rso-email-prototype.html`), swapping dummy data for fetches. Add this self-contained module near the other panel renderers (e.g. beside `renderInboxPanel`):

```js
const HubInbox = (function () {
  let currentScope = 'mine';
  let currentCaseId = null;

  async function loadList() {
    const r = await fetch('/api/admin/inbox/conversations?scope=' + currentScope, { credentials: 'same-origin' });
    const j = await r.json();
    renderList((j && j.conversations) || []);
  }
  function renderList(convs) {
    const panel = document.getElementById('hubInboxPanel');
    const needs = convs.filter(c => c.needsReply).length;
    panel.innerHTML =
      '<div class="hub-inbox-head"><h2>📥 Registration Inbox</h2>' +
      '<div class="hub-filters">' +
        '<button class="hub-filt ' + (currentScope==='mine'?'active':'') + '" data-scope="mine">Mine</button>' +
        '<button class="hub-filt ' + (currentScope==='all'?'active':'') + '" data-scope="all">All RSOs</button>' +
        '<span class="hub-needs">' + needs + ' need a reply</span></div></div>' +
      '<div class="hub-conv-list">' + convs.map(rowHtml).join('') + '</div>';
    panel.querySelectorAll('.hub-filt').forEach(b => b.addEventListener('click', () => {
      currentScope = b.getAttribute('data-scope'); loadList();
    }));
    panel.querySelectorAll('.hub-conv-row').forEach(r => r.addEventListener('click', () => openThread(r.getAttribute('data-cid'))));
  }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function rowHtml(c) {
    const badge = c.needsReply ? '<span class="hub-badge reply">Needs reply</span>' : '<span class="hub-badge waiting">Waiting on doctor</span>';
    const dot = c.unread ? '<span class="hub-dot"></span>' : '';
    return '<div class="hub-conv-row ' + (c.unread?'unread':'') + '" data-cid="' + esc(c.caseId) + '">' +
      '<div class="hub-conv-main"><div class="hub-conv-top"><span class="hub-conv-name">' + esc(c.name) + '</span>' +
      '<span class="hub-conv-time">' + esc(c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : '') + '</span></div>' +
      '<div class="hub-conv-prev">' + (c.lastDirection==='inbound'?'':'You: ') + esc(c.lastPreview) + '</div>' +
      '<div class="hub-conv-tags"><span class="hub-chip stage">' + esc(c.stage||'') + '</span>' +
      '<span class="hub-chip rso">' + esc(c.assignedRsoName||'') + '</span>' + badge + '</div></div>' + dot + '</div>';
  }
  async function openThread(caseId) {
    currentCaseId = caseId;
    const r = await fetch('/api/admin/inbox/thread?caseId=' + encodeURIComponent(caseId), { credentials: 'same-origin' });
    const j = await r.json();
    renderThread(j.header, j.messages || []);
    fetch('/api/admin/inbox/mark-read', { method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caseId }) });
  }
  function renderThread(header, messages) {
    const panel = document.getElementById('hubInboxPanel');
    panel.innerHTML =
      '<button class="hub-back">← Inbox</button>' +
      '<div class="hub-thread-head"><h2>' + esc(header.name) + '</h2>' +
        '<span class="hub-chip stage">' + esc(header.stage) + '</span>' +
        '<span class="hub-chip rso">RSO: ' + esc(header.assignedRsoName) + '</span></div>' +
      '<div class="hub-thread">' + messages.map(msgHtml).join('') + '</div>' +
      '<div class="hub-composer"><div class="hub-sendingas">Sending as: <b>' +
        esc(header.assignedRsoName ? header.assignedRsoName + ' — GP Link' : 'GP Link Registration') +
        '</b> &lt;registration@mygplink.com.au&gt;</div>' +
      '<textarea id="hubReply" placeholder="Type your reply…"></textarea>' +
      '<div class="hub-composer-foot"><button id="hubSend" class="hub-send">Send</button></div></div>';
    panel.querySelector('.hub-back').addEventListener('click', loadList);
    panel.querySelector('#hubSend').addEventListener('click', () => sendReply(header));
    const t = panel.querySelector('.hub-thread'); t.scrollTop = t.scrollHeight;
  }
  function msgHtml(m) {
    const out = m.direction === 'outbound';
    return '<div class="hub-msg ' + (out?'sent':'reply') + '"><div class="hub-msg-top">' +
      '<span class="hub-dir ' + (out?'out':'in') + '">' + (out?'SENT':'REPLY') + '</span>' +
      '<span class="hub-msg-time">' + esc(m.created_at ? new Date(m.created_at).toLocaleString() : '') + '</span></div>' +
      '<div class="hub-msg-subj">' + esc(m.subject||'') + '</div>' +
      '<div class="hub-msg-body">' + esc(m.body_text||'') + '</div></div>';
  }
  async function sendReply(header) {
    const ta = document.getElementById('hubReply'); const txt = (ta.value||'').trim(); if (!txt) return;
    const last = null; // reply endpoint resolves threadId from the task itself
    await fetch('/api/admin/email/send', { method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ caseId: header.caseId, subject: 'Re: (registration)', bodyHtml: '<p>'+esc(txt)+'</p>', bodyText: txt }) });
    openThread(header.caseId);
  }
  return { show() { document.getElementById('hubInboxPanel').style.display = ''; loadList(); }, hide() { document.getElementById('hubInboxPanel').style.display = 'none'; } };
})();
```

Wire `HubInbox.show()` into the existing tab-switch handler for `data-view="hubInbox"` (find where other `data-view` tabs toggle their panels and add the case). Add the CSS (port the `.hub-*` rules from the prototype's `<style>` block) into `admin.html`'s stylesheet.

> Implementer note: the reply send currently posts `caseId` only; confirm `/api/admin/email/send` can resolve the recipient `to` + `threadId` from `caseId` alone. If it requires `to`/`taskId`, extend the thread endpoint (Task 6) to also return the latest task id + the GP/practice `to` address, and pass them here. This is the one place to verify end-to-end (CLAUDE.md rule 8).

- [ ] **Step 3: Bump cache-buster**

Change `admin.html` line 8 main script version to the next letter for today, e.g. `?v=20260627a`.

- [ ] **Step 4: Visual verification**

Start a static check via headless Chrome against a logged-in admin session is not possible offline; instead verify the panel renders with mocked data by loading `pages/rso-email-prototype.html` (already done) and confirm the ported markup/CSS matches. Confirm `node --check server.js` and `npx vitest run` stay green.

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat(hub): Registration Inbox tab in admin dashboard (list + thread + reply)"
```

---

### Task 8: Operator setup guide + go-live verification

**Files:**
- Create: `docs/registration-email-hub-setup.md`
- Test: full suite + manual go-live checklist.

- [ ] **Step 1: Write the setup guide**

Document, in plain language, the exact steps the operator must do (the parts this build cannot do):

```markdown
# Registration Email Hub — Go-Live Setup

The app code is ready. Live email stays OFF until these steps are done.

## 1. Create the mailbox (Google Workspace admin)
- Create `registration@mygplink.com.au` as a normal user mailbox (NOT just an alias — the app sends *as* it and reads its inbox).
- Confirm the existing Google service account's domain-wide delegation covers it (same delegation already used for hazel@). No new scopes needed; the scopes are gmail.modify + send.

## 2. Turn it on (environment variables — Vercel project settings)
- `REGISTRATION_HUB_EMAIL=registration@mygplink.com.au`
- (Optional) add it to `MONITORED_VA_EMAILS` too; the code also auto-adds it, but being explicit is fine.
- Redeploy.

## 3. Register the inbox watch
- Hit `GET /api/cron/renew-gmail-watch` once (or wait for the daily cron). Confirm a row appears in `gmail_watch_state` for registration@.

## 4. Apply the DB migration
- Run `supabase/migrations/20260627000000_task_messages_read_at.sql` against prod (via the exec_sql RPC with the service key, per the team convention).

## 5. Verify end-to-end (do this with ONE real test case first)
- From the admin Inbox, send a doc-request to a test address. Confirm the recipient sees it from "registration@mygplink.com.au" with the RSO's name.
- Reply to it. Confirm the reply appears in that case's thread within ~1 min and the Inbox row flips to "Needs reply".
- Only then roll out to real doctors.

## Rollback
- Unset `REGISTRATION_HUB_EMAIL` and redeploy. Sending reverts to per-RSO mailboxes immediately. (Inbound replies already in the hub remain filed; new ones go back to per-RSO inboxes.)
```

- [ ] **Step 2: Final full verification**

Run: `npx vitest run` → Expected: full green, baseline + new tests.
Run: `node --check server.js` → clean.

- [ ] **Step 3: Commit**

```bash
git add docs/registration-email-hub-setup.md
git commit -m "docs(hub): operator go-live setup + rollback guide"
```

---

## Self-Review

- **Spec coverage:** outbound flip (Tasks 1–3), inbound watch (Task 4), data gap/unread (Task 4), inbox list (Task 5), thread + mark-read (Task 6), UI (Task 7), go-live + the operator-only mailbox dependency (Task 8). All covered.
- **Non-destructive default:** every server change is gated on `REGISTRATION_HUB_EMAIL` being non-empty; with it empty, `resolveSender` returns today's values, the config block is a no-op, and the new endpoints/UI are additive. ✔
- **Type consistency:** `resolveSender` → `{ from, fromName }` used identically in Tasks 2–3; `Conversation` shape from Task 5 consumed verbatim by Task 7's `rowHtml`; `header` shape from Task 6 consumed by Task 7's `renderThread`. ✔
- **Known verification point:** Task 7 Step 2 flags the one genuine end-to-end unknown — whether `/api/admin/email/send` resolves `to`/`threadId` from `caseId` alone — and tells the implementer to confirm and extend Task 6's response if not. ✔
```
