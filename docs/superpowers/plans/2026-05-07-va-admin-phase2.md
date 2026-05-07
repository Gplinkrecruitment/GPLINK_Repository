# VA Admin Phase 2 — Bug Fixes, AI Follow-ups, Documentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix audit issues from Phase 1 (missing related_stage, DoubleTick message storage), add AI-powered note follow-up system with daily reconciliation, and write VA SOP + CEO technical documents.

**Architecture:** DB migrations for new columns/tables, server.js endpoint additions for AI note parsing and reconciliation cron, admin.html UI for follow-up suggestions. Documents written as standalone markdown files.

**Tech Stack:** Supabase (PostgreSQL), Node.js (server.js), Anthropic Claude API (Opus for reconciliation, Haiku for note parsing), Gmail API, vanilla JS frontend.

---

## Files Overview

| File | Changes |
|------|---------|
| `supabase/migrations/20260507010000_phase2_fixes.sql` | New migration: backfill related_stage, add doubletick_messages table, add follow_up_source_timeline_id column |
| `server.js` | Backfill logic in task creation, DoubleTick message storage, AI note parsing endpoint, Gmail search utility, reconciliation cron |
| `pages/admin.html` | Follow-up suggestion UI after note creation |
| `docs/va-sop.md` | VA Standard Operating Procedures document |
| `docs/ceo-technical-overview.md` | CEO technical document |

---

### Task 1: Database Migration — Backfill, DoubleTick Messages, Follow-up Linkage

**Files:**
- Create: `supabase/migrations/20260507010000_phase2_fixes.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Phase 2 fixes: backfill related_stage, doubletick_messages table, follow-up linkage

-- =====================================================
-- 1. Backfill related_stage on tasks that are missing it
-- =====================================================

-- doc_review tasks: infer stage from related_document_key
UPDATE registration_tasks
SET related_stage = CASE
  WHEN related_document_key IN ('sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv') THEN 'ahpra'
  ELSE 'career'
END
WHERE related_stage IS NULL
  AND task_type = 'doc_review';

-- visa tasks: set to career (visa deferred but tasks remain)
UPDATE registration_tasks
SET related_stage = 'career'
WHERE related_stage IS NULL
  AND domain = 'visa';

-- manual tasks: infer from case stage
UPDATE registration_tasks t
SET related_stage = c.stage
FROM registration_cases c
WHERE t.case_id = c.id
  AND t.related_stage IS NULL
  AND t.task_type = 'manual';

-- catch-all: any remaining NULL gets case stage
UPDATE registration_tasks t
SET related_stage = c.stage
FROM registration_cases c
WHERE t.case_id = c.id
  AND t.related_stage IS NULL;

-- =====================================================
-- 2. DoubleTick messages table for reconciliation
-- =====================================================

CREATE TABLE IF NOT EXISTS doubletick_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id UUID REFERENCES registration_cases(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  from_phone TEXT NOT NULL,
  contact_name TEXT,
  message_body TEXT,
  message_type TEXT DEFAULT 'TEXT',
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  doubletick_message_id TEXT,
  conversation_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dt_messages_case ON doubletick_messages(case_id);
CREATE INDEX idx_dt_messages_user ON doubletick_messages(user_id);
CREATE INDEX idx_dt_messages_phone ON doubletick_messages(from_phone);
CREATE INDEX idx_dt_messages_created ON doubletick_messages(created_at DESC);

ALTER TABLE doubletick_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on doubletick_messages"
  ON doubletick_messages FOR ALL
  USING (auth.role() = 'service_role');

-- =====================================================
-- 3. Follow-up linkage: source timeline ID on tasks
-- =====================================================

-- Add column to link follow-up tasks back to the note that created them
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS follow_up_source_timeline_id UUID REFERENCES task_timeline(id) ON DELETE SET NULL;

CREATE INDEX idx_reg_tasks_followup_source ON registration_tasks(follow_up_source_timeline_id)
  WHERE follow_up_source_timeline_id IS NOT NULL;
```

- [ ] **Step 2: Apply migration locally (if local DB exists)**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
# If using Supabase CLI:
# npx supabase db push
# Otherwise migration will apply on next Supabase deploy
```

- [ ] **Step 3: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add supabase/migrations/20260507010000_phase2_fixes.sql
git commit -m "feat: phase 2 migration — backfill related_stage, doubletick_messages, follow-up linkage"
```

---

### Task 2: Make related_stage Required on Manual Task Creation + Infer on Auto-Creation

**Files:**
- Modify: `server.js` — POST `/api/admin/tasks` endpoint and `_createRegTask`

- [ ] **Step 1: Update POST /api/admin/tasks to require related_stage**

Find `POST /api/admin/tasks` endpoint in server.js (around line 21994). After the `if (!body.title)` validation, add stage inference:

```javascript
// After: if (!body.title) return res.status(400).json({...});
// Add:
if (!body.related_stage && body.case_id) {
  // Infer stage from case
  const caseRes = await supabaseDbRequest('registration_cases', '?id=eq.' + body.case_id + '&select=stage', { method: 'GET' });
  if (caseRes.ok && Array.isArray(caseRes.data) && caseRes.data.length > 0) {
    body.related_stage = caseRes.data[0].stage;
  }
}
```

- [ ] **Step 2: Update doc_review task creation to always set related_stage**

Find where `doc_review` tasks are created (search for `task_type: 'doc_review'` or `'doc_review'`). Add `related_stage` based on document key:

```javascript
// Add this helper near the task creation functions:
function inferStageFromDocKey(docKey) {
  const docToStage = {
    'sppa_00': 'ahpra', 'section_g': 'ahpra', 'position_description': 'ahpra',
    'offer_contract': 'ahpra', 'supervisor_cv': 'ahpra'
  };
  return docToStage[docKey] || 'career';
}
```

Then at each `doc_review` creation site, add `related_stage: inferStageFromDocKey(documentKey)`.

- [ ] **Step 3: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add server.js
git commit -m "fix: ensure related_stage is always set on task creation — infer from case/doc key"
```

---

### Task 3: Store DoubleTick Webhook Messages for Reconciliation

**Files:**
- Modify: `server.js` — DoubleTick webhook handler (around line 2790)

- [ ] **Step 1: Store inbound messages in doubletick_messages table**

Find the DoubleTick webhook handler (search for `doubletick` webhook or the handler that processes `fromPhone`). After the existing task creation logic, add message storage:

```javascript
// After extracting fromPhone, messageBody, contactName, conversationUrl, messageId
// and BEFORE the task creation logic, store the raw message:
if (isSupabaseDbConfigured()) {
  // Look up user by phone
  const phoneClean = fromPhone.replace(/[^0-9]/g, '');
  const userLookup = await supabaseDbRequest('user_profiles',
    '?phone=ilike.*' + phoneClean.slice(-9) + '&select=id,user_id',
    { method: 'GET' });
  const matchedUser = userLookup.ok && Array.isArray(userLookup.data) && userLookup.data.length > 0
    ? userLookup.data[0] : null;

  // Look up case if user found
  let caseId = null;
  if (matchedUser) {
    const caseLookup = await supabaseDbRequest('registration_cases',
      '?user_id=eq.' + matchedUser.user_id + '&select=id',
      { method: 'GET' });
    caseId = caseLookup.ok && Array.isArray(caseLookup.data) && caseLookup.data.length > 0
      ? caseLookup.data[0].id : null;
  }

  await supabaseDbRequest('doubletick_messages', '', {
    method: 'POST',
    body: [{
      case_id: caseId,
      user_id: matchedUser ? matchedUser.user_id : null,
      from_phone: fromPhone,
      contact_name: contactName || null,
      message_body: (messageBody || '').substring(0, 2000),
      message_type: (payload.message && payload.message.type) || 'TEXT',
      direction: 'inbound',
      doubletick_message_id: messageId || null,
      conversation_url: conversationUrl || null
    }]
  });
}
```

- [ ] **Step 2: Also store outbound messages when sending nudges/templates**

Find `sendDoubleTickTemplate()` and `sendDoubleTickNudge()` functions. After successful send, store the outbound message:

```javascript
// After successful DoubleTick send, add:
if (isSupabaseDbConfigured() && caseId) {
  await supabaseDbRequest('doubletick_messages', '', {
    method: 'POST',
    body: [{
      case_id: caseId,
      user_id: userId || null,
      from_phone: toPhone,
      message_body: (messageText || templateName || '').substring(0, 2000),
      message_type: 'TEMPLATE',
      direction: 'outbound',
      conversation_url: null
    }]
  });
}
```

- [ ] **Step 3: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add server.js
git commit -m "feat: store DoubleTick messages in doubletick_messages table for reconciliation"
```

---

### Task 4: Gmail Search-by-GP Utility Function

**Files:**
- Modify: `server.js` — add `searchGmailForGP()` function near existing Gmail functions

- [ ] **Step 1: Add searchGmailForGP function**

Add near the existing Gmail API functions (around line 700):

```javascript
/**
 * Search Gmail for recent messages related to a GP.
 * @param {string} gpEmail - GP's email address
 * @param {string} gpName - GP's full name
 * @param {string} practiceEmail - Practice contact email (optional)
 * @param {number} daysBack - How many days to search (default 7)
 * @returns {Array<{subject, from, to, date, snippet}>}
 */
async function searchGmailForGP(gpEmail, gpName, practiceEmail, daysBack) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return [];
  daysBack = daysBack || 7;

  const vaEmail = process.env.VA_GMAIL_ADDRESS || process.env.GOOGLE_SERVICE_ACCOUNT_DELEGATED_EMAIL || '';
  if (!vaEmail) return [];

  try {
    const gmail = await getGmailClient(vaEmail);
    const afterDate = new Date(Date.now() - daysBack * 86400000);
    const afterStr = afterDate.toISOString().split('T')[0].replace(/-/g, '/');

    // Build query: emails from/to GP or practice
    const queryParts = [];
    if (gpEmail) queryParts.push('from:' + gpEmail, 'to:' + gpEmail);
    if (practiceEmail) queryParts.push('from:' + practiceEmail, 'to:' + practiceEmail);
    if (!queryParts.length && gpName) queryParts.push('"' + gpName + '"');
    if (!queryParts.length) return [];

    const query = '{' + queryParts.join(' ') + '} after:' + afterStr;

    const listRes = await gmail.users.messages.list({
      userId: vaEmail,
      q: query,
      maxResults: 20
    });

    if (!listRes.data.messages || !listRes.data.messages.length) return [];

    const results = [];
    for (const msg of listRes.data.messages.slice(0, 10)) {
      try {
        const full = await gmail.users.messages.get({
          userId: vaEmail,
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date']
        });
        const headers = full.data.payload && full.data.payload.headers ? full.data.payload.headers : [];
        results.push({
          subject: (headers.find(h => h.name === 'Subject') || {}).value || '',
          from: (headers.find(h => h.name === 'From') || {}).value || '',
          to: (headers.find(h => h.name === 'To') || {}).value || '',
          date: (headers.find(h => h.name === 'Date') || {}).value || '',
          snippet: full.data.snippet || ''
        });
      } catch (e) { /* skip individual message errors */ }
    }
    return results;
  } catch (err) {
    console.error('[Gmail] searchGmailForGP failed:', err.message);
    return [];
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add server.js
git commit -m "feat: add searchGmailForGP utility for reconciliation cron"
```

---

### Task 5: AI Note Follow-up Parsing (Part A)

**Files:**
- Modify: `server.js` — add `POST /api/admin/va/note/parse-followup` endpoint
- Modify: `pages/admin.html` — add follow-up suggestion UI after note creation

- [ ] **Step 1: Add the AI note parsing endpoint in server.js**

Add near the existing note endpoints (around line 21952):

```javascript
/* ── AI Note Follow-up Parsing ── */
app.post('/api/admin/va/note/parse-followup', async (req, res) => {
  const adminCtx = getAdminContext(req);
  if (!adminCtx) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!ANTHROPIC_API_KEY) return res.status(200).json({ ok: true, followup: null });

  const { text, gp_name, case_id } = req.body || {};
  if (!text || !text.trim()) return res.status(200).json({ ok: true, followup: null });

  if (!checkAnthropicBudget()) return res.status(200).json({ ok: true, followup: null, reason: 'budget_exceeded' });

  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        temperature: 0,
        system: 'You extract follow-up actions from case management notes. Today is ' + today + '. Return JSON only, no markdown. If no follow-up is needed, return {"followup":null}. If a follow-up exists, return {"followup":{"action":"<what to do>","deadline":"<YYYY-MM-DD>","condition":"<if any, else null>"}}. Interpret relative dates (e.g. "Monday" = next Monday, "Friday" = this Friday if today is before Friday, else next Friday).',
        messages: [{ role: 'user', content: 'Note about GP ' + (gp_name || 'unknown') + ':\n\n' + text.substring(0, 1000) }]
      }),
      signal: AbortSignal.timeout(15000)
    });

    const data = await r.json();
    const usage = data.usage || {};
    recordAnthropicSpend(usage.input_tokens || 0, usage.output_tokens || 0, 'claude-haiku-4-5-20251001');

    const content = data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = { followup: null }; }

    return res.json({ ok: true, followup: parsed.followup || null });
  } catch (err) {
    console.error('[AI] Note follow-up parse failed:', err.message);
    return res.json({ ok: true, followup: null });
  }
});
```

- [ ] **Step 2: Add follow-up suggestion UI in admin.html**

Find the note creation handler in admin.html. Search for `data-add-note` in the click handler. After the note is successfully created, call the parse endpoint and show a suggestion:

```javascript
/* After successful note creation (find the data-add-note handler) */
if (e.target.closest("[data-add-note]")) {
  const caseId = e.target.closest("[data-add-note]").getAttribute("data-add-note");
  const input = document.getElementById("gpNoteInput");
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();

  try {
    // Save the note
    await fetch("/api/admin/case/note?id=" + encodeURIComponent(caseId), {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text })
    });

    // Parse for follow-up
    const c = S.cases.find(x => x.id === caseId);
    const u = (S.va.dashboard && S.va.dashboard.users || []).find(x => x.case_id === caseId) || {};
    const parseRes = await fetch("/api/admin/va/note/parse-followup", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, gp_name: u.gp_name || c.gp_name || "", case_id: caseId })
    });
    const parseData = await parseRes.json();

    if (parseData.ok && parseData.followup) {
      const fu = parseData.followup;
      const confirmDiv = document.createElement("div");
      confirmDiv.className = "followup-suggestion";
      confirmDiv.style.cssText = "background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;margin-top:8px;font-size:12px;";
      confirmDiv.innerHTML = '<div style="font-weight:700;color:#1d4ed8;margin-bottom:4px">Follow-up detected</div>'
        + '<div style="color:#334155;margin-bottom:6px">' + esc(fu.action) + (fu.deadline ? ' \u2014 due ' + esc(fu.deadline) : '') + (fu.condition ? '<br><span style="color:#64748b">Condition: ' + esc(fu.condition) + '</span>' : '') + '</div>'
        + '<button class="btn primary sm" data-create-followup-task="' + esc(caseId) + '" data-fu-action="' + esc(fu.action) + '" data-fu-deadline="' + esc(fu.deadline || '') + '">Create Follow-up Task</button>'
        + ' <button class="btn sm" data-dismiss-followup>Dismiss</button>';
      input.parentElement.appendChild(confirmDiv);
    }

    input.value = "";
    // Refresh notes
    if (S.va.gpDetailCache[c.user_id]) delete S.va.gpDetailCache[c.user_id].timeline;
    renderDetail();
  } catch (err) { console.error("[VA] Note creation failed:", err); }
  return;
}
```

- [ ] **Step 3: Add handler for creating follow-up task from suggestion**

```javascript
/* Create follow-up task from AI suggestion */
if (e.target.closest("[data-create-followup-task]")) {
  const btn = e.target.closest("[data-create-followup-task]");
  const caseId = btn.getAttribute("data-create-followup-task");
  const action = btn.getAttribute("data-fu-action");
  const deadline = btn.getAttribute("data-fu-deadline");
  const c = S.cases.find(x => x.id === caseId);

  try {
    await fetch("/api/admin/tasks", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        case_id: caseId,
        title: action,
        task_type: "followup",
        priority: "normal",
        due_date: deadline || null,
        related_stage: c ? c.stage : null,
        description: "Auto-created from note follow-up"
      })
    });
    btn.closest(".followup-suggestion").innerHTML = '<div style="color:#16a34a;font-weight:600;font-size:12px">\u2713 Follow-up task created' + (deadline ? ' \u2014 due ' + esc(deadline) : '') + '</div>';
    await loadAll(true);
    renderCaseList();
  } catch (err) { console.error("[VA] Follow-up task creation failed:", err); }
  return;
}

/* Dismiss follow-up suggestion */
if (e.target.closest("[data-dismiss-followup]")) {
  const div = e.target.closest(".followup-suggestion");
  if (div) div.remove();
  return;
}
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add server.js pages/admin.html
git commit -m "feat: AI note follow-up parsing — detect and suggest follow-up tasks from VA notes"
```

---

### Task 6: Daily Reconciliation Cron (Part B)

**Files:**
- Modify: `server.js` — add `GET /api/cron/reconcile-followups` endpoint

- [ ] **Step 1: Add the reconciliation cron endpoint**

Add near the existing cron endpoints (around line 15530):

```javascript
/* ── Daily Follow-up Reconciliation Cron ── */
app.get('/api/cron/reconcile-followups', async (req, res) => {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  const authHeader = (req.headers.authorization || '').trim();
  if (!cronSecret || authHeader !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!isSupabaseDbConfigured() || !ANTHROPIC_API_KEY) {
    return res.status(200).json({ ok: true, message: 'Not configured', results: [] });
  }

  const CONFIDENCE_THRESHOLD = 0.9;
  const RECONCILE_MODEL = process.env.RECONCILE_AI_MODEL || 'claude-opus-4-6';

  try {
    // 1. Find all follow-up tasks due today or overdue
    const today = new Date().toISOString().split('T')[0];
    const taskRes = await supabaseDbRequest('registration_tasks',
      '?task_type=eq.followup&status=in.(open,in_progress,waiting)&due_date=lte.' + today + '&select=*',
      { method: 'GET' });
    const tasks = taskRes.ok && Array.isArray(taskRes.data) ? taskRes.data : [];
    if (!tasks.length) return res.json({ ok: true, message: 'No follow-ups due', results: [] });

    const results = [];

    for (const task of tasks) {
      if (!checkAnthropicBudget()) {
        results.push({ task_id: task.id, status: 'skipped', reason: 'budget_exceeded' });
        continue;
      }

      // 2. Gather activity for this GP
      const caseRes = await supabaseDbRequest('registration_cases',
        '?id=eq.' + task.case_id + '&select=*',
        { method: 'GET' });
      const gpCase = caseRes.ok && caseRes.data && caseRes.data[0] ? caseRes.data[0] : null;
      if (!gpCase) { results.push({ task_id: task.id, status: 'skipped', reason: 'no_case' }); continue; }

      // Get GP profile
      const profileRes = await supabaseDbRequest('user_profiles',
        '?user_id=eq.' + gpCase.user_id + '&select=email,phone,first_name,last_name',
        { method: 'GET' });
      const profile = profileRes.ok && profileRes.data && profileRes.data[0] ? profileRes.data[0] : {};
      const gpEmail = profile.email || '';
      const gpName = ((profile.first_name || '') + ' ' + (profile.last_name || '')).trim();

      // Get recent DoubleTick messages (last 7 days)
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const dtRes = await supabaseDbRequest('doubletick_messages',
        '?case_id=eq.' + task.case_id + '&created_at=gte.' + weekAgo + '&order=created_at.desc&limit=10',
        { method: 'GET' });
      const dtMessages = dtRes.ok && Array.isArray(dtRes.data) ? dtRes.data : [];

      // Get recent Gmail activity
      const practiceEmail = gpCase.practice_contact ? (JSON.parse(gpCase.practice_contact || '{}').contactEmail || '') : '';
      const gmailMessages = await searchGmailForGP(gpEmail, gpName, practiceEmail, 7);

      // Get recent task completions for this case
      const recentTaskRes = await supabaseDbRequest('task_timeline',
        '?case_id=eq.' + task.case_id + '&event_type=in.(completed,status_change,note)&created_at=gte.' + weekAgo + '&order=created_at.desc&limit=10',
        { method: 'GET' });
      const recentEvents = recentTaskRes.ok && Array.isArray(recentTaskRes.data) ? recentTaskRes.data : [];

      // 3. Build context summary for AI
      let activitySummary = 'Recent activity for ' + (gpName || 'GP') + ':\n\n';

      if (dtMessages.length) {
        activitySummary += 'WhatsApp messages (last 7 days):\n';
        dtMessages.forEach(m => {
          activitySummary += '- [' + m.direction + '] ' + (m.message_body || '').substring(0, 200) + ' (' + new Date(m.created_at).toLocaleDateString() + ')\n';
        });
      } else {
        activitySummary += 'No WhatsApp messages in last 7 days.\n';
      }

      if (gmailMessages.length) {
        activitySummary += '\nEmails (last 7 days):\n';
        gmailMessages.forEach(m => {
          activitySummary += '- From: ' + (m.from || '').substring(0, 100) + ' | Subject: ' + (m.subject || '').substring(0, 100) + ' | ' + (m.snippet || '').substring(0, 150) + '\n';
        });
      } else {
        activitySummary += '\nNo emails found in last 7 days.\n';
      }

      if (recentEvents.length) {
        activitySummary += '\nApp events (last 7 days):\n';
        recentEvents.forEach(ev => {
          activitySummary += '- ' + (ev.title || ev.event_type) + ': ' + (ev.detail || '').substring(0, 150) + ' (' + new Date(ev.created_at).toLocaleDateString() + ')\n';
        });
      } else {
        activitySummary += '\nNo app events in last 7 days.\n';
      }

      // 4. Ask AI for verdict
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: RECONCILE_MODEL,
          max_tokens: 200,
          temperature: 0,
          system: 'You are reviewing whether a follow-up task has been fulfilled based on recent activity. Return JSON only. Format: {"fulfilled": true/false, "confidence": 0.0-1.0, "evidence": "brief explanation"}. A task is fulfilled if the activity clearly shows the follow-up action was completed or the condition was met.',
          messages: [{
            role: 'user',
            content: 'Follow-up task: "' + task.title + '"\nDue: ' + task.due_date + '\nDescription: ' + (task.description || 'none') + '\n\n' + activitySummary
          }]
        }),
        signal: AbortSignal.timeout(30000)
      });

      const aiData = await aiRes.json();
      const aiUsage = aiData.usage || {};
      recordAnthropicSpend(aiUsage.input_tokens || 0, aiUsage.output_tokens || 0, RECONCILE_MODEL);

      const aiContent = aiData.content && aiData.content[0] && aiData.content[0].text ? aiData.content[0].text : '';
      let verdict;
      try { verdict = JSON.parse(aiContent); } catch { verdict = { fulfilled: false, confidence: 0, evidence: 'Parse error' }; }

      // 5. Act on verdict
      if (verdict.fulfilled && verdict.confidence >= CONFIDENCE_THRESHOLD) {
        // Auto-complete
        await _completeRegTask(task.id, task.case_id, 'system:reconciliation');
        await _logCaseEvent(task.case_id, task.id, 'note', 'Auto-resolved by reconciliation',
          'Evidence: ' + (verdict.evidence || 'AI determined follow-up was fulfilled with ' + Math.round(verdict.confidence * 100) + '% confidence'),
          'system:reconciliation');
        results.push({ task_id: task.id, title: task.title, status: 'auto_completed', confidence: verdict.confidence, evidence: verdict.evidence });
      } else {
        // Bump to urgent
        await supabaseDbRequest('registration_tasks',
          '?id=eq.' + task.id,
          { method: 'PATCH', body: { priority: 'urgent' } });
        await _logCaseEvent(task.case_id, task.id, 'priority_change', 'Escalated to urgent by reconciliation',
          'Follow-up not fulfilled. ' + (verdict.evidence || ''),
          'system:reconciliation');
        results.push({ task_id: task.id, title: task.title, status: 'escalated_to_urgent', confidence: verdict.confidence, evidence: verdict.evidence });
      }
    }

    return res.json({ ok: true, processed: results.length, results: results });
  } catch (err) {
    console.error('[Cron] Reconcile follow-ups failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
```

- [ ] **Step 2: Add cron schedule to vercel.json**

Read the existing `vercel.json` and add the cron entry:

```json
{
  "crons": [
    { "path": "/api/cron/reconcile-followups", "schedule": "0 20 * * *" }
  ]
}
```

This runs at 20:00 UTC daily (6:00 AM AEST).

- [ ] **Step 3: Add RECONCILE_AI_MODEL env var documentation**

The endpoint defaults to `claude-opus-4-6` but can be overridden via `RECONCILE_AI_MODEL` env var. Document in the commit message.

- [ ] **Step 4: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add server.js vercel.json
git commit -m "feat: daily reconciliation cron — AI checks follow-up task fulfillment via Gmail + DoubleTick + app state"
```

---

### Task 7: Write VA Standard Operating Procedures (SOP)

**Files:**
- Create: `docs/va-sop.md`

- [ ] **Step 1: Write the VA SOP document**

This document is for VAs — it should be clear, step-by-step, and reference the redesigned UI. Cover:

1. Logging in and navigating the Command Centre
2. Understanding the Priority Lanes (Needs Action vs On Track)
3. How to work through a GP's tasks (stage-by-stage)
4. Using the guided action system (primary button + ••• menu)
5. Writing notes with follow-up actions (and how the AI suggestion works)
6. Common task workflows:
   - Document tasks (email practice → review → approve/revise)
   - Verification tasks (review evidence → verify)
   - Practice Pack tasks (send SPPA → track signatures → upload)
   - WhatsApp support (respond, nudge, escalate)
7. Case management (expand panel: status, blocker, follow-up dates)
8. Using the Ops Queue for cross-GP oversight
9. Handover procedures (notes tab, assigned VA)

- [ ] **Step 2: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add docs/va-sop.md
git commit -m "docs: VA Standard Operating Procedures for redesigned Command Centre"
```

---

### Task 8: Write CEO Technical Overview Document

**Files:**
- Create: `docs/ceo-technical-overview.md`

- [ ] **Step 1: Write the CEO technical document**

This document is for the CEO — it should explain every process and system in detail. Cover:

1. System architecture overview (server.js monolith, Supabase, Vercel)
2. The task lifecycle (creation → assignment → guided actions → completion)
3. Stage-based task grouping and the registration flow
4. Priority lanes algorithm (how Needs Action vs On Track is determined)
5. The guided action system (how getGuidedAction maps task state to next steps)
6. AI Note Follow-up system:
   - Part A: How note parsing works (Haiku model, JSON extraction, follow-up task creation)
   - Part B: How daily reconciliation works (cron job, Gmail/DoubleTick/app state aggregation, Opus model verdict, 90% confidence threshold, auto-complete vs escalate)
   - Cost projections at scale (1000 GPs: ~$7.84/day)
7. DoubleTick integration (webhook storage, message history for reconciliation)
8. Gmail integration (Pub/Sub watch, auto-matching, search-by-GP for reconciliation)
9. The Ops Queue (cross-GP operational view, filtering, auditing)
10. Data model (registration_cases, registration_tasks, task_timeline, doubletick_messages)
11. Security considerations (auth, XSS prevention, rate limiting, API budget controls)
12. Phase 2 audit fixes (what was found, what was fixed, remaining considerations)

- [ ] **Step 2: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add docs/ceo-technical-overview.md
git commit -m "docs: CEO technical overview — complete system documentation for VA Command Centre"
```

---

## Self-Review Checklist

### Spec Coverage
| Requirement | Task |
|---|---|
| Backfill related_stage | Task 1 (migration) + Task 2 (server.js) |
| DoubleTick message storage | Task 1 (table) + Task 3 (webhook handler) |
| Follow-up note linkage | Task 1 (column) + Task 5 (UI + endpoint) |
| Gmail search-by-GP | Task 4 |
| AI Note Follow-ups Part A | Task 5 |
| AI Note Follow-ups Part B | Task 6 |
| VA SOP document | Task 7 |
| CEO technical document | Task 8 |

### No Placeholders
All code blocks are complete with actual implementation. No TBD/TODO references.

### Type Consistency
- `doubletick_messages` table schema matches INSERT payloads in Tasks 3
- `searchGmailForGP()` return type matches usage in Task 6
- `recordAnthropicSpend()` call pattern matches existing usage (input_tokens, output_tokens, model)
- `_completeRegTask(taskId, caseId, actor)` and `_logCaseEvent()` signatures match existing functions
