# Email Triage Suggested Reply — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the VA clicks an email triage task, show the full email, GP context, a link to the Gmail thread, and an AI-suggested reply they can copy/edit.

**Architecture:** Three layers — (1) migration + pipeline fix to store email data on the task, (2) a new API endpoint that gathers GP context and calls Claude for a reply draft, (3) an expanded email task card in the admin HTML that renders the email, context, and reply textarea.

**Tech Stack:** Supabase (migration), server.js (API endpoint + pipeline fix), admin.html (UI), Claude API (reply generation), Gmail API (thread fetch), DoubleTick API (chat messages)

---

### Task 1: Migration — add email columns to registration_tasks

**Files:**
- Create: `supabase/migrations/20260508010000_email_triage_columns.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Add email metadata columns for email_triage tasks
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS email_body_snippet text,
  ADD COLUMN IF NOT EXISTS email_sender text,
  ADD COLUMN IF NOT EXISTS gmail_thread_id text;
```

- [ ] **Step 2: Run migration**

Run: `supabase db push --linked`
Expected: Migration applied successfully.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260508010000_email_triage_columns.sql
git commit -m "migration: add email_body_snippet, email_sender, gmail_thread_id to registration_tasks"
```

---

### Task 2: Store email data when creating triage tasks

**Files:**
- Modify: `server.js` — `extractEmailMeta` (~line 485) and triage task creation (~line 976)

- [ ] **Step 1: Add threadId to extractEmailMeta return object**

In `server.js`, find the return statement of `extractEmailMeta` (around line 485):

```js
  return {
    messageId: gmailMessage.id,
    sender: sender,
    senderName: senderName,
    subject: getHeader('Subject'),
    to: getHeader('To'),
    date: getHeader('Date'),
    bodyText: bodyText.substring(0, 2000),
    attachments: attachments
  };
```

Change to:

```js
  return {
    messageId: gmailMessage.id,
    threadId: gmailMessage.threadId || '',
    sender: sender,
    senderName: senderName,
    subject: getHeader('Subject'),
    to: getHeader('To'),
    date: getHeader('Date'),
    bodyText: bodyText.substring(0, 2000),
    attachments: attachments
  };
```

- [ ] **Step 2: Pass email fields to _createRegTask**

Find the `_createRegTask` call in the triage path (around line 976). The current call is:

```js
await _createRegTask(gpCase.id, {
  task_type: 'email_triage',
  title: (isAhpra ? '\u26a0\ufe0f AHPRA: ' : '\u2709\ufe0f Email: ') + (emailMeta.subject || 'No subject'),
  description: triageResult.summary || ('Email from ' + (emailMeta.sender || 'unknown') + ' — ' + (emailMeta.subject || '')),
  priority: triageResult.urgency === 'urgent' ? 'urgent' : triageResult.urgency === 'high' ? 'high' : 'normal',
  source_trigger: 'gmail_triage',
  related_stage: isAhpra ? 'ahpra' : (gpCase.stage || ''),
  gmail_message_id: currentMsgId,
  _actor: 'system'
});
```

Change to:

```js
await _createRegTask(gpCase.id, {
  task_type: 'email_triage',
  title: (isAhpra ? '\u26a0\ufe0f AHPRA: ' : '\u2709\ufe0f Email: ') + (emailMeta.subject || 'No subject'),
  description: triageResult.summary || ('Email from ' + (emailMeta.sender || 'unknown') + ' — ' + (emailMeta.subject || '')),
  priority: triageResult.urgency === 'urgent' ? 'urgent' : triageResult.urgency === 'high' ? 'high' : 'normal',
  source_trigger: 'gmail_triage',
  related_stage: isAhpra ? 'ahpra' : (gpCase.stage || ''),
  gmail_message_id: currentMsgId,
  email_body_snippet: (emailMeta.bodyText || '').substring(0, 2000),
  email_sender: emailMeta.sender || '',
  gmail_thread_id: emailMeta.threadId || '',
  _actor: 'system'
});
```

- [ ] **Step 3: Backfill the existing task for Smith Miller**

Run against Supabase:
```sql
UPDATE registration_tasks
SET email_sender = 'khaleedmahmoud1211@gmail.com',
    email_body_snippet = 'updated on progress'
WHERE id = 'da7e3fb8-13f5-4724-8d57-4ef7447afe2e';
```

- [ ] **Step 4: Verify syntax and commit**

```bash
node -c server.js
git add server.js
git commit -m "feat: store email body, sender, and thread ID on email triage tasks"
```

---

### Task 3: Include email fields in dashboard task response

**Files:**
- Modify: `server.js` — the dashboard enriched tasks query (around line 22530)

- [ ] **Step 1: Add email fields to the enriched task response**

Find the `enrichedTasks` mapping (around line 22530, the `Object.assign({}, t, {` block). The task object `t` already includes all columns from the `registration_tasks` SELECT (which is `select=*` or a specific column list). Check if the dashboard tasks query selects all columns.

Search for the tasks query in the dashboard handler — it should be something like:
```
supabaseDbRequest('registration_tasks', 'select=*&...')
```

If the SELECT is `*`, the email fields are already included automatically. If it uses a specific column list, add `email_body_snippet,email_sender,gmail_thread_id` to it.

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: include email fields in dashboard task response"
```

---

### Task 4: Suggest-reply API endpoint

**Files:**
- Modify: `server.js` — add new endpoint before same-origin block or in admin API section

- [ ] **Step 1: Add the suggest-reply endpoint**

Find the admin API section (around where `/api/admin/` routes are defined, after same-origin enforcement). Add:

```js
if (pathname === '/api/admin/email-triage/suggest-reply' && req.method === 'POST') {
  const adminCtx = requireAdminSession(req, res);
  if (!adminCtx) return;
  let body;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid request.' }); return; }
  const taskId = String(body.taskId || '').trim();
  if (!taskId) { sendJson(res, 400, { ok: false, message: 'taskId required.' }); return; }

  try {
    // 1. Load task
    const taskRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    const task = taskRes.ok && Array.isArray(taskRes.data) && taskRes.data[0] ? taskRes.data[0] : null;
    if (!task) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }

    // 2. Load registration case
    const caseRes = await supabaseDbRequest('registration_cases', 'select=*&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    const regCase = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0] : {};

    // 3. Load GP profile
    const profRes = await supabaseDbRequest('user_profiles', 'select=first_name,last_name,email,phone,country_dial,phone_number,registration_country&user_id=eq.' + encodeURIComponent(regCase.user_id) + '&limit=1');
    const profile = profRes.ok && Array.isArray(profRes.data) && profRes.data[0] ? profRes.data[0] : {};
    const gpName = ((profile.first_name || '') + ' ' + (profile.last_name || '')).trim() || profile.email || 'Unknown';
    const gpPhone = profile.phone || [profile.country_dial, profile.phone_number].filter(Boolean).join(' ').trim() || '';

    // 4. Load open tasks for this case
    const tasksRes = await supabaseDbRequest('registration_tasks', 'select=title,priority,related_stage,status&case_id=eq.' + encodeURIComponent(task.case_id) + '&status=neq.completed&status=neq.cancelled&limit=20');
    const openTasks = tasksRes.ok && Array.isArray(tasksRes.data) ? tasksRes.data : [];

    // 5. Load qualification snapshot
    const countryCode = profile.registration_country || regCase.country || 'GB';
    const qualSnap = await getUserQualificationSnapshot(regCase.user_id, countryCode);

    // 6. Fetch DoubleTick messages (best-effort)
    var dtMessages = [];
    if (DOUBLETICK_API_KEY && gpPhone) {
      try {
        const dtPhone = normalizePhone(gpPhone).replace(/[^\d]/g, '');
        const wabaNumber = String(HAZEL_WHATSAPP_NUMBER || '').replace(/[^\d]/g, '');
        if (dtPhone && wabaNumber) {
          const dtResp = await fetch(DOUBLETICK_BASE_URL + '/chat-messages?wabaNumber=' + wabaNumber + '&customerNumber=' + dtPhone, {
            headers: { 'Authorization': DOUBLETICK_API_KEY, 'Content-Type': 'application/json' }
          });
          if (dtResp.ok) {
            const dtData = await dtResp.json();
            dtMessages = Array.isArray(dtData.messages) ? dtData.messages.slice(0, 10).map(function (m) {
              return { from: m.senderUser ? m.senderUser.name : (m.senderId || 'unknown'), text: m.text || m.content || '', date: m.timestamp ? new Date(m.timestamp).toISOString() : '' };
            }) : [];
          }
        }
      } catch (dtErr) { console.warn('[suggest-reply] DoubleTick fetch failed:', dtErr.message); }
    }

    // 7. Fetch Gmail thread (best-effort)
    var emailThread = [];
    if (task.gmail_thread_id) {
      try {
        var gmail = await getGmailClient('hazel@mygplink.com.au');
        if (gmail) {
          var threadRes = await gmail.users.threads.get({ userId: 'hazel@mygplink.com.au', id: task.gmail_thread_id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] });
          if (threadRes.data && Array.isArray(threadRes.data.messages)) {
            emailThread = threadRes.data.messages.map(function (m) {
              var hdrs = {};
              if (m.payload && Array.isArray(m.payload.headers)) m.payload.headers.forEach(function (h) { hdrs[h.name] = h.value; });
              return { from: hdrs.From || '', to: hdrs.To || '', subject: hdrs.Subject || '', date: hdrs.Date || '', snippet: m.snippet || '' };
            });
          }
        }
      } catch (gmErr) { console.warn('[suggest-reply] Gmail thread fetch failed:', gmErr.message); }
    }

    // 8. Build context and call Claude
    var contextJson = JSON.stringify({
      gp: { name: gpName, email: profile.email, phone: gpPhone, country: countryCode },
      registration: { stage: regCase.stage, substage: regCase.substage, blocker: regCase.blocker_status, practice: regCase.practice_name || '' },
      open_tasks: openTasks.map(function (t) { return t.title + ' (' + t.priority + ', ' + t.related_stage + ')'; }),
      qualifications: { required: qualSnap.required.length, approved: qualSnap.approved.length, missing: qualSnap.missing.map(function (m) { return m.label || m.key; }) },
      whatsapp_recent: dtMessages,
      email_thread: emailThread,
      current_email: { from: task.email_sender, subject: task.title, body: task.email_body_snippet || task.description }
    }, null, 2);

    var systemPrompt = 'You are drafting an email reply for Hazel, a Virtual Assistant at GP Link who helps international GPs register to practice in Australia. Write a professional, helpful reply. Use the GP context provided to give accurate, specific information. Keep the tone warm but professional. Do not fabricate information — only reference what the context shows. Return ONLY the email reply text, no subject line or metadata.';

    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { sendJson(res, 503, { ok: false, message: 'AI not configured.' }); return; }

    var controller = new AbortController();
    var aiTimeout = setTimeout(function () { controller.abort(); }, 30000);
    try {
      var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: controller.signal,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: 'GP CONTEXT:\n' + contextJson + '\n\nDraft a reply to the latest email in the thread.' }]
        })
      });
      clearTimeout(aiTimeout);
      if (!aiResp.ok) { sendJson(res, 502, { ok: false, message: 'AI request failed.' }); return; }
      var aiData = await aiResp.json();
      var suggestedReply = (aiData.content && aiData.content[0] && aiData.content[0].text) || '';

      if (aiData.usage) {
        recordAnthropicSpend(aiData.usage.input_tokens || 0, aiData.usage.output_tokens || 0, aiData.usage.cache_read_input_tokens || 0, aiData.usage.cache_creation_input_tokens || 0);
      }

      sendJson(res, 200, {
        ok: true,
        suggestedReply: suggestedReply,
        context: {
          gp_name: gpName,
          stage: regCase.stage,
          practice: regCase.practice_name || '',
          open_tasks: openTasks.length,
          quals_approved: qualSnap.approved.length,
          quals_required: qualSnap.required.length,
          whatsapp_messages: dtMessages.length,
          email_thread_length: emailThread.length
        }
      });
    } catch (aiErr) {
      clearTimeout(aiTimeout);
      sendJson(res, 502, { ok: false, message: 'AI timeout or error: ' + aiErr.message });
    }
  } catch (err) {
    console.error('[suggest-reply] Error:', err.message);
    sendJson(res, 500, { ok: false, message: 'Internal error.' });
  }
  return;
}
```

Place this in the admin API section (after same-origin enforcement, near other `/api/admin/` handlers).

- [ ] **Step 2: Verify syntax and commit**

```bash
node -c server.js
git add server.js
git commit -m "feat: add POST /api/admin/email-triage/suggest-reply endpoint"
```

---

### Task 5: Email triage expanded card in admin UI

**Files:**
- Modify: `pages/admin.html` — add CSS + modify task card renderer + add click handlers

- [ ] **Step 1: Add CSS for the email triage expanded panel**

Find the task card CSS section (around the `.stage-task` styles). Add:

```css
.et-panel{background:var(--bg2,#f8fafc);border:1px solid var(--line,#e5e7eb);border-radius:8px;padding:14px;margin-top:8px}
.et-section{margin-bottom:12px}
.et-section-title{font-size:11px;text-transform:uppercase;color:var(--muted,#9aa3b2);font-weight:700;margin-bottom:6px}
.et-email-from{font-size:12px;color:var(--text);font-weight:600}
.et-email-body{font-size:12px;color:var(--text);line-height:1.5;white-space:pre-wrap;max-height:200px;overflow-y:auto;background:var(--bg1,#fff);border:1px solid var(--line);border-radius:6px;padding:10px;margin-top:6px}
.et-ctx-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px}
.et-ctx-item{padding:6px 8px;background:var(--bg1,#fff);border-radius:4px}
.et-ctx-label{font-size:10px;color:var(--muted);text-transform:uppercase}
.et-reply-area{width:100%;min-height:120px;padding:10px;font-family:inherit;font-size:13px;border:1px solid var(--line);border-radius:6px;background:var(--bg1,#fff);color:var(--text);resize:vertical}
.et-btn-row{display:flex;gap:8px;margin-top:8px;align-items:center}
.et-note{font-size:10px;color:var(--muted);margin-left:8px}
```

- [ ] **Step 2: Modify task card renderer for email_triage tasks**

In the `renderGpTasksPane` function, find the `group.tasks.forEach(t=>{` loop (around line 1942). Inside, after the existing task card HTML is built (after the `st-actions` div, around line 2003), add the email triage expanded panel. Insert BEFORE the final `</div>` that closes `.stage-task`:

Replace the closing of the stage-task div block. After `html+='</div>';` (the one closing st-actions, around line 2002), and before the final `html+='</div>';` that closes `.stage-task`, add:

```js
          // Email triage expanded panel (toggles on click)
          if(t.task_type==='email_triage'){
            var emailSubject=(t.title||'').replace(/^[\u2709\ufe0f\u26a0\ufe0f\s]*(AHPRA:\s*|Email:\s*)/,'');
            var gmailUrl=t.gmail_thread_id?'https://mail.google.com/mail/u/0/#inbox/'+encodeURIComponent(t.gmail_thread_id):'';
            html+='<div class="et-panel" id="et-panel-'+esc(t.id)+'" style="display:none">';

            // Email section
            html+='<div class="et-section"><div class="et-section-title">Email</div>';
            html+='<div class="et-email-from">From: '+esc(t.email_sender||'Unknown')+'</div>';
            html+='<div style="font-size:12px;margin-top:2px"><strong>Subject:</strong> '+esc(emailSubject)+'</div>';
            if(t.email_body_snippet)html+='<div class="et-email-body">'+esc(t.email_body_snippet)+'</div>';
            if(gmailUrl)html+='<a class="btn sm" href="'+esc(gmailUrl)+'" target="_blank" rel="noopener" style="margin-top:8px">\uD83D\uDD17 Open in Gmail</a>';
            html+='</div>';

            // GP Context section
            html+='<div class="et-section"><div class="et-section-title">GP Context</div>';
            html+='<div class="et-ctx-grid">';
            html+='<div class="et-ctx-item"><div class="et-ctx-label">Stage</div>'+esc(c.stage||'Unknown')+'</div>';
            html+='<div class="et-ctx-item"><div class="et-ctx-label">Practice</div>'+esc(u.practice_name||(u.practice_contact&&u.practice_contact.practiceName)||c.practice_name||'Not placed')+'</div>';
            html+='<div class="et-ctx-item"><div class="et-ctx-label">Open Tasks</div>'+tasks.length+'</div>';
            html+='<div class="et-ctx-item"><div class="et-ctx-label">Qualifications</div>'+(u.quals_approved||0)+'/'+(u.quals_required||0)+' approved</div>';
            html+='</div></div>';

            // Suggested Reply section
            html+='<div class="et-section"><div class="et-section-title">Suggested Reply</div>';
            html+='<button class="btn sm primary" data-generate-reply="'+esc(t.id)+'">Generate Suggested Reply</button>';
            html+='<div id="et-reply-wrap-'+esc(t.id)+'" style="display:none;margin-top:8px">';
            html+='<textarea class="et-reply-area" id="et-reply-'+esc(t.id)+'"></textarea>';
            html+='<div class="et-btn-row"><button class="btn sm" data-copy-reply="'+esc(t.id)+'">Copy to Clipboard</button>';
            if(gmailUrl)html+='<a class="btn sm" href="'+esc(gmailUrl)+'" target="_blank" rel="noopener">Open Gmail to Reply</a>';
            html+='<span class="et-note">This is a suggestion \u2014 edit as needed before sending.</span></div>';
            html+='</div></div>';

            // Actions
            html+='<div class="et-btn-row" style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px">';
            html+='<button class="btn sm" data-complete-task="'+esc(t.id)+'">\u2713 Mark Resolved</button>';
            html+='</div>';

            html+='</div>';
          }
```

- [ ] **Step 3: Add click handler to toggle the email panel**

In the `detailContent` click handler (around line 3209), add a handler for clicking email triage task rows. Place it near the top of the handler, before the guided-action handler:

```js
      /* Toggle email triage panel */
      var etRow=e.target.closest("[data-task-row]");
      if(etRow){
        var panelId="et-panel-"+etRow.getAttribute("data-task-row");
        var panel=document.getElementById(panelId);
        if(panel){
          panel.style.display=panel.style.display==="none"?"block":"none";
          // Don't return — allow other click handlers to fire too if needed
        }
      }
```

- [ ] **Step 4: Add click handler for Generate Reply button**

In the same `detailContent` click handler, add:

```js
      /* Generate suggested reply */
      if(e.target.closest("[data-generate-reply]")){
        var replyBtn=e.target.closest("[data-generate-reply]");
        var replyTaskId=replyBtn.getAttribute("data-generate-reply");
        replyBtn.disabled=true;
        replyBtn.textContent="Generating\u2026";
        try{
          var rr=await fetch("/api/admin/email-triage/suggest-reply",{
            method:"POST",credentials:"same-origin",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({taskId:replyTaskId})
          });
          var rd=await rr.json().catch(function(){return {};});
          if(rd.ok&&rd.suggestedReply){
            var replyWrap=document.getElementById("et-reply-wrap-"+replyTaskId);
            var replyArea=document.getElementById("et-reply-"+replyTaskId);
            if(replyWrap)replyWrap.style.display="block";
            if(replyArea)replyArea.value=rd.suggestedReply;
            replyBtn.textContent="\u2713 Reply Generated";
          }else{
            replyBtn.textContent="Failed \u2014 try again";
            replyBtn.disabled=false;
          }
        }catch(err){
          replyBtn.textContent="Error \u2014 try again";
          replyBtn.disabled=false;
        }
        return;
      }
```

- [ ] **Step 5: Add click handler for Copy to Clipboard**

```js
      /* Copy reply to clipboard */
      if(e.target.closest("[data-copy-reply]")){
        var copyId=e.target.closest("[data-copy-reply]").getAttribute("data-copy-reply");
        var copyArea=document.getElementById("et-reply-"+copyId);
        if(copyArea&&copyArea.value){
          navigator.clipboard.writeText(copyArea.value).then(function(){
            var btn=e.target.closest("[data-copy-reply]");
            btn.textContent="\u2713 Copied!";
            setTimeout(function(){btn.textContent="Copy to Clipboard";},2000);
          });
        }
        return;
      }
```

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html
git commit -m "feat: email triage expanded card with email content, GP context, and AI reply"
```

---

### Task 6: End-to-end test and push

- [ ] **Step 1: Verify syntax of both files**

```bash
node -c server.js
```

- [ ] **Step 2: Push all commits**

```bash
git push
```

- [ ] **Step 3: After deploy, test by clicking the reinstated email task on Smith Miller's profile**

Verify:
1. Clicking the task toggles the expanded email panel
2. Email from/subject/body snippet display correctly
3. GP context shows stage (ahpra), practice (SOP Medical Centre), task count, qual status
4. "Generate Suggested Reply" button calls the API and populates the textarea
5. "Copy to Clipboard" copies the reply text
6. "Open in Gmail" links to the correct thread
7. "Mark Resolved" closes the task
