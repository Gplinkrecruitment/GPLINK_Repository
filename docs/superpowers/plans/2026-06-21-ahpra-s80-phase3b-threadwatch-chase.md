# AHPRA s80 — Phase 3b: AI Thread-Watch + "Confirmed Received" + Auto-Chase — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop trusting the GP's "I requested it" tick alone — automatically detect when an institution's document actually reaches AHPRA (by reading the CC'd email thread), show the doctor a "Confirmed received" state, and auto-chase items that stay unconfirmed too long.

**Architecture:** Extends the daily reconciliation cron (`GET /api/cron/reconcile-followups`) with two s80 passes (thread-watch + chase) and adds a `received_confirmed_at` metadata signal surfaced as a "Confirmed" status to GP and admin. Reads the AHPRA thread via the assigned RSO's **watched** Gmail (`getGmailClient` + `threads.get` + `extractEmailMeta`). Auto-confirm is gated on a high confidence line and **notifies the RSO** so a human always sees it. All data in `registration_tasks.metadata` — no migration.

**Tech Stack:** Node.js `server.js`, vanilla inline JS (`pages/ahpra.html`, `pages/admin.html`), Anthropic API (raw fetch), Gmail API (service account). No UI harness; verify pure helpers via extract-and-run, endpoints/cron via `node --check` + review; cron behaviour is integration-only (verified by review + careful idempotency design).

**Spec:** `docs/superpowers/specs/2026-06-21-ahpra-s80-improvements-design.md` (Part C — thread-watch + chase; Part D — confirmed status).

## Global Constraints

- **AI calls use `ANTHROPIC_S80_MODEL` (claude-opus-4-8) WITHOUT `temperature`** (that model 400s on temperature). The thread-watch AI call must not send `temperature`/`thinking`.
- **Auto-confirm is high-confidence only** (`S80_AUTO_CONFIDENCE = 0.92`) and **idempotent** (skip items already confirmed; the query excludes them). Every auto-confirm → `_logCaseEvent` + an RSO notification.
- **Auto-confirm is additive** — it sets `received_confirmed_at` and stops the chase; it must NOT cancel/close anything the team relies on, and must never *un-confirm*.
- **Auto-chase is idempotent** — track `metadata.last_chased_at`; only re-chase after `S80_CHASE_DAYS`.
- **Reads only a watched inbox** — resolve the CC address with a `watch_active=eq.true` filter; if it falls back to the archive (never watched), skip thread-watch for that item (chase still applies).
- **No DB migration**; escape all interpolated text; commit after each task; subagents do NOT push. Use the temp Node at `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node` for `node --check`.

## File structure (Phase 3b)

- **Modify** `server.js` — constants `S80_AUTO_CONFIDENCE`, `S80_CHASE_DAYS`; `watch_active` filter on `resolveS80CcAddress`; "confirmed" status logic + `received_confirmed_at` on the GP item; two cron passes (thread-watch, chase).
- **Modify** `pages/ahpra.html` — `s80StatusChip` "confirmed" entry; "Confirmed received" render in the request branch.
- **Modify** `pages/admin.html` — "Confirmed received by AHPRA" line in the `renderS80Active` request branch.

---

### Task 1: Constants, watch_active filter, and "confirmed" status data (server.js)

**Files:** Modify `server.js` — constants (~line 201); `resolveS80CcAddress` query (~line 347); GP status logic (~line 29518) + item object (~line 29544).

**Interfaces:**
- Produces: `S80_AUTO_CONFIDENCE` (0.92) and `S80_CHASE_DAYS` (7) module constants (consumed by Tasks 3/4 and Phase 5). `resolveS80CcAddress` now returns only a watched RSO inbox (else archive). GP item gains `received_confirmed_at`; `status` becomes `'confirmed'` when `m.received_confirmed_at` is set.

- [ ] **Step 1: Add the shared s80 automation constants**

In `server.js`, immediately AFTER the `ANTHROPIC_S80_MODEL` line (201), add:
```js
// Shared AHPRA s80 automation thresholds (also used by the reconciliation cron + Phase 5).
const S80_AUTO_CONFIDENCE = Number(process.env.S80_AUTO_CONFIDENCE || '0.92') || 0.92;
const S80_CHASE_DAYS = Number(process.env.S80_CHASE_DAYS || '7') || 7;
```

- [ ] **Step 2: Only surface a watched inbox as the CC address**

In `resolveS80CcAddress`, change the `va_gmail_accounts` query to require `watch_active`:
```js
      const r = await supabaseDbRequest('va_gmail_accounts',
        'select=email_address&watch_active=eq.true&user_id=eq.' + encodeURIComponent(rsoUserId) + '&limit=1');
```
(Everything else in the helper stays; an unwatched RSO now falls through to `MASTER_ARCHIVE_EMAIL`.)

- [ ] **Step 3: Add the "confirmed" status + expose `received_confirmed_at`**

In `GET /api/ahpra/more-info`, change the request-institution status line (currently `status = m.gp_marked_complete_at ? 'requested' : 'todo';`) to:
```js
        status = m.received_confirmed_at ? 'confirmed' : (m.gp_marked_complete_at ? 'requested' : 'todo');
```
Then in the `s80Items.push({...})` object, add (next to `gp_marked_complete_at`):
```js
        received_confirmed_at: m.received_confirmed_at || null,
```

- [ ] **Step 4: Verify**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo "server.js OK"
grep -n "S80_AUTO_CONFIDENCE\|S80_CHASE_DAYS\|watch_active=eq.true&user_id\|received_confirmed_at ? 'confirmed'\|received_confirmed_at: m.received_confirmed_at" server.js
```
Expect: `server.js OK`; constants defined once each; the watched filter present; confirmed-status line present; `received_confirmed_at` in the item once.

- [ ] **Step 5: Commit (do NOT push)**
```bash
git add server.js
git commit -m "AHPRA s80: automation constants, watched-inbox CC filter, 'confirmed' status data"
```

---

### Task 2: "Confirmed received" display (GP page + admin)

**Files:** Modify `pages/ahpra.html` (`s80StatusChip` ~4339; request branch in `ahpraMoreInfoItemHtml`); `pages/admin.html` (`renderS80Active` request branch).

**Interfaces:** Consumes `item.status === 'confirmed'` (GP) and `m.received_confirmed_at` (admin).

- [ ] **Step 1: Add a "Confirmed" chip state**

In `pages/ahpra.html`, in `s80StatusChip`'s `map`, add a `confirmed` entry (use a distinct, stronger green). Change the `map` object to include:
```js
        confirmed: ['Confirmed', '#15803d', '#bbf7d0'],
```
(Add it alongside the existing `requested`/`approved` entries.)

- [ ] **Step 2: Render the confirmed state in the request branch**

In `ahpraMoreInfoItemHtml`, in the `if (item.mode === 'request_institution') {` block, handle the confirmed status FIRST. Change the inner `if (item.status === 'requested') { ... } else { ... }` to a three-way:
```js
        if (item.status === 'confirmed') {
          action = '<div style="color:var(--gp-green-ink,#15803d);font-size:13px;font-weight:600;">✓ Confirmed received by AHPRA.</div>';
        } else if (item.status === 'requested') {
          action = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--gp-green-ink,#15803d);font-size:13px;font-weight:600;">' +
            '<span>✓ Marked as requested — we will confirm receipt with AHPRA.</span>' +
            '<button type="button" data-mi-unmark="' + s80Esc(item.id) + '" style="background:none;border:none;color:var(--ink-muted);text-decoration:underline;cursor:pointer;font-size:12px;padding:0;">Undo</button></div>';
        } else {
          var inst = item.institution ? s80Esc(item.institution) : 'the issuing institution';
          var hint = (item.gp_instructions || (item.how_to_steps && item.how_to_steps.length)) ? '' :
            '<div style="color:var(--ink-muted);font-size:13px;line-height:1.5;">Request this directly from ' + inst + ', then mark it done here.</div>';
          action = hint + '<button type="button" class="btn-primary" data-mi-mark="' + s80Esc(item.id) + '" style="margin-top:8px;">Mark as requested</button>';
        }
```
(The `action += s80ProofControl(item);` line added in Phase 3a stays right after this block.)

- [ ] **Step 3: Verify the chip helper (extract-and-run)**

Extend the chip check — create `$CLAUDE_JOB_DIR/tmp/verify-chip2.cjs`:
```js
const fs=require('fs');const html=fs.readFileSync(process.argv[2],'utf8');
const start=html.indexOf('function s80StatusChip(');let i=html.indexOf('{',start),d=0,end=-1;
for(;i<html.length;i++){if(html[i]==='{')d++;else if(html[i]==='}'){d--;if(d===0){end=i+1;break;}}}
const chip=new Function(html.slice(start,end)+'\nreturn s80StatusChip;')();
let p=0,f=0;const ok=(n,c)=>{c?p++:(f++,console.log('FAIL',n));};
ok('confirmed -> Confirmed', chip({status:'confirmed'}).includes('Confirmed'));
ok('requested still works', chip({status:'requested'}).includes('Requested'));
ok('unknown -> To do', chip({status:'zzz'}).includes('To do'));
console.log('RESULT:',p,'passed,',f,'failed');process.exit(f?1:0);
```
Run with the temp Node + ahpra.html path → expect 3/3.

- [ ] **Step 4: Admin — show confirmed line in the request branch**

In `pages/admin.html` `renderS80Active`, in the `request_institution` branch, the Phase-3a proof line was added after the `gp_marked_complete_at` if/else. Immediately BEFORE that proof line, add a confirmed line:
```js
        if(m.received_confirmed_at){ html+='<div style="font-size:12px;margin-top:6px;color:#15803d;font-weight:600;">✓ Confirmed received by AHPRA ('+esc(fmtD(m.received_confirmed_at))+').</div>'; }
```
(`fmtD` is the existing admin date formatter used elsewhere in this file; if unsure it exists, use `esc(m.received_confirmed_at)` instead.)

- [ ] **Step 5: Verify + commit**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node "$CLAUDE_JOB_DIR/tmp/verify-chip2.cjs" "$(pwd)/pages/ahpra.html"
grep -n "received_confirmed_at){ html" pages/admin.html
git add pages/ahpra.html pages/admin.html
git commit -m "AHPRA s80: show 'Confirmed received by AHPRA' state to GP + admin"
```

---

### Task 3: AI thread-watch in the reconciliation cron (server.js)

**Files:** Modify `server.js` — inside `GET /api/cron/reconcile-followups`, insert a block immediately BEFORE the `sendJson(res, 200, { ok: true, processed: rfResults.length, results: rfResults });` line (~21608), after the `for (var rfTask of rfTasks)` loop closes.

**Interfaces:**
- Consumes: `S80_AUTO_CONFIDENCE`, `resolveS80CcAddress`, `getGmailClient`, `extractEmailMeta`, `ANTHROPIC_S80_MODEL`, `ANTHROPIC_API_KEY`, `recordAnthropicSpend`, `pushDocumentNotificationToUser`, `_logCaseEvent`, `supabaseDbRequest`, `isGmailConfigured`.
- Produces: sets `metadata.received_confirmed_at` (ISO) on confirmed items; pushes results into `rfResults`.

- [ ] **Step 1: Insert the thread-watch block**

In `server.js`, immediately BEFORE the line `      sendJson(res, 200, { ok: true, processed: rfResults.length, results: rfResults });` (the reconcile cron's success response), insert:

```js
      // ── AHPRA s80 thread-watch: confirm institution-request items from the CC'd thread ──
      if (isGmailConfigured()) {
        var twRes = await supabaseDbRequest('registration_tasks',
          'select=*&task_type=eq.ahpra_action_item&limit=300', { method: 'GET' });
        var twTasks = (twRes.ok && Array.isArray(twRes.data)) ? twRes.data : [];
        for (var twTask of twTasks) {
          var twM = (twTask.metadata && typeof twTask.metadata === 'object') ? twTask.metadata : {};
          if (!twM.s80 || twM.mode !== 'request_institution' || twM.review_status !== 'active') continue;
          if (!twM.gp_marked_complete_at || twM.received_confirmed_at) continue;
          if (twTask.status === 'cancelled') continue;
          var twThreadId = twTask.gmail_thread_id || (twM.original_email && twM.original_email.threadId) || '';
          if (!twThreadId) continue;
          try {
            var twCc = await resolveS80CcAddress(twTask.case_id);
            if (!twCc || twCc === MASTER_ARCHIVE_EMAIL) continue; // only a watched inbox can be read
            var twGmail = await getGmailClient(twCc);
            if (!twGmail) continue;
            var twThread = await twGmail.users.threads.get({ userId: twCc, id: twThreadId, format: 'full' });
            var twMsgs = (twThread.data && Array.isArray(twThread.data.messages)) ? twThread.data.messages : [];
            if (!twMsgs.length) continue;
            var twText = twMsgs.map(function (mm) { var em = extractEmailMeta(mm); return 'From: ' + em.sender + '\nSubject: ' + em.subject + '\n' + em.bodyText; }).join('\n---\n').slice(0, 12000);
            var twAi = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: ANTHROPIC_S80_MODEL,
                max_tokens: 300,
                system: 'You read an email thread between a GP support team and AHPRA. Decide whether the specific requested document below has now been received by AHPRA (e.g. AHPRA confirms receipt, or the issuing institution confirms it was sent directly to AHPRA). Be conservative: only say received if the thread clearly shows it. Return JSON only: {"received": true|false, "confidence": 0.0-1.0, "evidence": "short quote/explanation"}.',
                messages: [{ role: 'user', content: 'Requested item: "' + (twTask.title || '') + '"' + (twM.institution ? ' (from ' + twM.institution + ')' : '') + '\n\nThread:\n' + twText }]
              }),
              signal: AbortSignal.timeout(30000)
            });
            var twData = await twAi.json();
            if (twData.usage) recordAnthropicSpend(twData.usage.input_tokens || 0, twData.usage.output_tokens || 0);
            var twRaw = twData.content && twData.content[0] && twData.content[0].text ? twData.content[0].text : '';
            var twMatch = twRaw.match(/\{[\s\S]*\}/);
            var twVerdict; try { twVerdict = JSON.parse(twMatch ? twMatch[0] : twRaw); } catch (e) { twVerdict = { received: false, confidence: 0 }; }
            if (twVerdict.received && twVerdict.confidence >= S80_AUTO_CONFIDENCE) {
              twM.received_confirmed_at = new Date().toISOString();
              twM.received_evidence = String(twVerdict.evidence || '').slice(0, 500);
              await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(twTask.id),
                { method: 'PATCH', body: { metadata: twM, updated_at: new Date().toISOString() } });
              await _logCaseEvent(twTask.case_id, twTask.id, 'note', 'AHPRA confirmed receipt (auto-detected)',
                'Thread-watch: ' + (twVerdict.evidence || 'institution document detected as received') + ' (' + Math.round(twVerdict.confidence * 100) + '% confidence)',
                'system:s80_thread_watch');
              try {
                var twCaseRes = await supabaseDbRequest('registration_cases', 'select=user_id,assigned_va&id=eq.' + encodeURIComponent(twTask.case_id) + '&limit=1');
                var twCaseRow = (twCaseRes.ok && Array.isArray(twCaseRes.data) && twCaseRes.data[0]) ? twCaseRes.data[0] : null;
                if (twCaseRow && twCaseRow.assigned_va) {
                  await pushDocumentNotificationToUser(twCaseRow.assigned_va, { type: 'info', title: 'AHPRA receipt auto-confirmed', detail: (twTask.title || 'An institution document') + ' looks received by AHPRA — please sanity-check.' });
                }
              } catch (e) { /* non-critical */ }
              rfResults.push({ task_id: twTask.id, title: twTask.title, status: 's80_confirmed', confidence: twVerdict.confidence });
            }
          } catch (e) { console.error('[Cron] s80 thread-watch failed for task ' + twTask.id + ':', e.message); }
        }
      }

```

- [ ] **Step 2: Verify**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo "server.js OK"
grep -n "s80 thread-watch\|received_confirmed_at = new Date\|status: 's80_confirmed'" server.js
```
Expect: `server.js OK`; the block present once; no `temperature` in the new AI call (confirm by reading the diff — the body has only model/max_tokens/system/messages).

- [ ] **Step 3: Commit (do NOT push)**
```bash
git add server.js
git commit -m "AHPRA s80: cron thread-watch auto-confirms institution receipt (Opus 4.8, no temperature)"
```

---

### Task 4: Auto-chase unconfirmed institution requests (server.js)

**Files:** Modify `server.js` — inside the reconcile cron, immediately AFTER the thread-watch block from Task 3 (still before the `sendJson` response).

**Interfaces:** Consumes `S80_CHASE_DAYS`, `pushDocumentNotificationToUser`, `_createRegTask`, `_logCaseEvent`, `resolveCaseRsoAssignee`. Produces: GP reminder + RSO chase task for stalled items; sets `metadata.last_chased_at`.

- [ ] **Step 1: Insert the chase block**

Immediately AFTER the thread-watch block (and before `sendJson(res, 200, { ok: true, processed: rfResults.length, results: rfResults });`), insert:

```js
      // ── AHPRA s80 auto-chase: nudge + alert when a request stays unconfirmed too long ──
      try {
        var chRes = await supabaseDbRequest('registration_tasks',
          'select=*&task_type=eq.ahpra_action_item&limit=300', { method: 'GET' });
        var chTasks = (chRes.ok && Array.isArray(chRes.data)) ? chRes.data : [];
        var chNow = Date.now();
        for (var chTask of chTasks) {
          var chM = (chTask.metadata && typeof chTask.metadata === 'object') ? chTask.metadata : {};
          if (!chM.s80 || chM.mode !== 'request_institution' || chM.review_status !== 'active') continue;
          if (!chM.gp_marked_complete_at || chM.received_confirmed_at) continue;
          if (chTask.status === 'cancelled') continue;
          var chSince = chNow - new Date(chM.gp_marked_complete_at).getTime();
          if (!(chSince >= S80_CHASE_DAYS * 86400000)) continue;
          var chLast = chM.last_chased_at ? (chNow - new Date(chM.last_chased_at).getTime()) : Infinity;
          if (chLast < S80_CHASE_DAYS * 86400000) continue; // already chased recently
          var chInst = chM.institution || 'the issuing institution';
          try {
            var chCaseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(chTask.case_id) + '&limit=1');
            var chUserId = (chCaseRes.ok && Array.isArray(chCaseRes.data) && chCaseRes.data[0]) ? chCaseRes.data[0].user_id : null;
            if (chUserId) {
              await pushDocumentNotificationToUser(chUserId, { type: 'action_required', title: 'Still waiting on ' + chInst,
                detail: 'We have not yet seen confirmation that "' + (chTask.title || 'your requested document') + '" reached AHPRA. Please follow up with ' + chInst + ' (and remember to CC us).' });
            }
            await _createRegTask(chTask.case_id, {
              task_type: 'chase', title: 'AHPRA request unconfirmed: ' + (chTask.title || 'institution document'),
              description: 'GP marked this requested ' + Math.floor(chSince / 86400000) + ' days ago but AHPRA receipt is not yet confirmed. Follow up with the GP / institution.',
              priority: 'high', source_trigger: 's80_chase', related_stage: 'ahpra', _actor: 'system'
            });
            chM.last_chased_at = new Date().toISOString();
            await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(chTask.id),
              { method: 'PATCH', body: { metadata: chM, updated_at: new Date().toISOString() } });
            await _logCaseEvent(chTask.case_id, chTask.id, 'note', 'Auto-chased unconfirmed AHPRA request',
              chInst + ' — ' + Math.floor(chSince / 86400000) + ' days since marked requested.', 'system:s80_chase');
            rfResults.push({ task_id: chTask.id, title: chTask.title, status: 's80_chased' });
          } catch (e) { console.error('[Cron] s80 chase failed for task ' + chTask.id + ':', e.message); }
        }
      } catch (e) { console.error('[Cron] s80 chase pass failed:', e.message); }

```

- [ ] **Step 2: Verify**
```bash
$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js && echo "server.js OK"
grep -n "s80 auto-chase\|last_chased_at = new Date\|status: 's80_chased'\|source_trigger: 's80_chase'" server.js
```
Expect: `server.js OK`; the block present once; chase guarded by `S80_CHASE_DAYS` and `last_chased_at` (idempotent).

- [ ] **Step 3: Commit (do NOT push)**
```bash
git add server.js
git commit -m "AHPRA s80: auto-chase institution requests unconfirmed past the chase window"
```

---

## Self-review (Phase 3b vs spec)

- **Spec coverage:** watched-inbox CC fix (3a follow-up) → Task 1; "confirmed received" status → Task 1 (data) + Task 2 (display); AI thread-watch → Task 3; auto-chase → Task 4. ✓
- **Placeholder scan:** all steps carry concrete code + verify commands. ✓
- **Type/name consistency:** `S80_AUTO_CONFIDENCE`/`S80_CHASE_DAYS` defined in Task 1, used in Tasks 3/4; `metadata.received_confirmed_at` set in Task 3, read by Task 1 status logic + Task 2 displays + excluded by Task 3/4 queries (idempotency); `metadata.last_chased_at` written/read in Task 4; `resolveS80CcAddress` watched-only in Task 1, used by Task 3. ✓
- **Safety:** thread-watch is high-confidence + idempotent + RSO-notified + only reads a watched inbox + AI call sends no `temperature`; chase is idempotent (`last_chased_at`) and additive; auto-confirm never un-confirms or cancels. ✓
- **Model safety:** thread-watch uses `ANTHROPIC_S80_MODEL` with no `temperature`/`thinking` (avoids the Opus 4.8 400). ✓
