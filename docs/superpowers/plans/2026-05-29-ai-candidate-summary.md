# AI Candidate Summary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI-generated intelligence brief card to the admin candidate detail view that aggregates emails, WhatsApp, support tickets, and case data into an actionable summary.

**Architecture:** New GET endpoint `/api/admin/candidate-summary` fetches data from 8 sources in parallel, sends to Claude Sonnet for structured JSON synthesis, saves the result as a rolling handover on the case record. Frontend renders a collapsible card between the profile bar and journey stepper in `renderDetail()`.

**Tech Stack:** Anthropic Claude API (Sonnet), Supabase (PostgreSQL), Gmail API, vanilla JS/HTML

**Spec:** `docs/superpowers/specs/2026-05-28-ai-candidate-summary-design.md`

---

### Task 1: Database Migration — Add `ai_handover_summary` Column

**Files:**
- Create: `supabase/migrations/20260529000000_add_ai_handover_summary.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Add JSONB column to store rolling AI handover summary
ALTER TABLE registration_cases
ADD COLUMN IF NOT EXISTS ai_handover_summary JSONB DEFAULT NULL;

COMMENT ON COLUMN registration_cases.ai_handover_summary IS
  'Rolling AI-generated summary carried forward across generations. Contains overview, action_items, concerns, key_history, generated_at.';
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260529000000_add_ai_handover_summary.sql
git commit -m "feat: add ai_handover_summary column to registration_cases"
```

---

### Task 2: Backend — `/api/admin/candidate-summary` Endpoint

**Files:**
- Modify: `server.js` (insert new endpoint after the `/api/admin/case/timeline` block, around line 25880)

**Context:** The endpoint follows the same patterns as `/api/admin/case` (line 25835): `requireAdminSession` auth, `supabaseDbRequest` queries, `Promise.all` for parallel fetches. AI call follows the pattern at line 22856 (`/api/ai/verify-qualification`): budget check via `checkAnthropicBudget()`, Anthropic fetch with headers, token tracking via `recordAnthropicSpend()`.

- [ ] **Step 1: Add the endpoint — data aggregation**

Insert after line 25879 (after the `/api/admin/case/timeline` endpoint's closing `return;`). The endpoint fetches all 8 data sources in parallel:

```javascript
  // ── AI Candidate Summary ──
  if (pathname === '/api/admin/candidate-summary' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const caseId = url.searchParams.get('case_id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing case_id.' }); return; }

    if (!ANTHROPIC_API_KEY) {
      sendJson(res, 503, { ok: false, error: 'AI service not configured.' });
      return;
    }
    if (!(await checkAnthropicBudget())) {
      sendJson(res, 200, { ok: false, error: 'AI budget limit reached for today.' });
      return;
    }

    try {
      // 1. Fetch case + profile
      const caseRes = await supabaseDbRequest('registration_cases', 'select=*&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
      if (!caseRes.ok || !Array.isArray(caseRes.data) || caseRes.data.length === 0) {
        sendJson(res, 404, { ok: false, error: 'Case not found.' });
        return;
      }
      const regCase = caseRes.data[0];
      const userId = regCase.user_id;

      const pRes = await supabaseDbRequest('user_profiles', 'select=first_name,last_name,email,phone_number,country&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
      const profile = pRes.ok && Array.isArray(pRes.data) && pRes.data.length > 0 ? pRes.data[0] : {};
      const gpName = [(profile.first_name || ''), (profile.last_name || '')].join(' ').trim() || 'Unknown';
      const gpEmail = profile.email || '';
      const gpPhone = profile.phone_number || '';
      const gpCountry = profile.country || regCase.country || '';

      let practiceEmail = '';
      try {
        const pc = regCase.practice_contact ? (typeof regCase.practice_contact === 'string' ? JSON.parse(regCase.practice_contact) : regCase.practice_contact) : {};
        practiceEmail = pc.contactEmail || pc.email || '';
      } catch (e) { /* ignore parse errors */ }

      // 2. Parallel fetch all data sources
      const [tasksRes, tlRes, msgRes, dtRes, ticketsRes, qualSnap, gmailMessages] = await Promise.all([
        supabaseDbRequest('registration_tasks', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.desc'),
        supabaseDbRequest('task_timeline', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.desc&limit=20'),
        supabaseDbRequest('task_messages', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.desc&limit=20'),
        supabaseDbRequest('doubletick_messages', 'case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.desc&limit=20'),
        supabaseDbRequest('support_tickets', 'select=*&user_id=eq.' + encodeURIComponent(userId) + '&status=neq.resolved&order=created_at.desc&limit=10'),
        (async () => {
          try { return await getUserQualificationSnapshot(userId, gpCountry || 'GB'); } catch { return null; }
        })(),
        (async () => {
          try { return await searchGmailForGP(gpEmail, gpName, practiceEmail, 30); } catch { return []; }
        })()
      ]);

      const tasks = tasksRes.ok && Array.isArray(tasksRes.data) ? tasksRes.data : [];
      const timeline = tlRes.ok && Array.isArray(tlRes.data) ? tlRes.data : [];
      const messages = msgRes.ok && Array.isArray(msgRes.data) ? msgRes.data : [];
      const dtMessages = dtRes.ok && Array.isArray(dtRes.data) ? dtRes.data : [];
      const tickets = ticketsRes.ok && Array.isArray(ticketsRes.data) ? ticketsRes.data : [];
      const quals = qualSnap || { approved: [], uploaded_unverified: [], missing: [] };
      const emails = gmailMessages || [];

      // 3. Build the prompt
      const practiceName = regCase.practice_name || '';
      const handover = regCase.ai_handover_summary || null;

      let prompt = 'CANDIDATE: Dr ' + gpName + ' | ' + gpEmail + ' | ' + gpPhone + ' | ' + gpCountry + '\n';
      prompt += 'PRACTICE: ' + practiceName + ' | ' + practiceEmail + '\n';
      prompt += 'STAGE: ' + (regCase.stage || 'unknown') + ' / ' + (regCase.substage || '') + ' | Status: ' + (regCase.status || '') + '\n';
      prompt += 'ASSIGNED VA: ' + (regCase.assigned_va || 'Unassigned') + '\n';
      prompt += 'REGISTERED: ' + (regCase.created_at || '') + ' | LAST ACTIVITY: ' + (regCase.last_gp_activity_at || regCase.updated_at || '') + '\n';
      prompt += 'BLOCKER: ' + (regCase.blocker_reason || 'None') + '\n\n';

      prompt += '--- TASKS (' + tasks.length + ') ---\n';
      tasks.forEach(function(t) {
        prompt += '[' + (t.status || 'open') + '] ' + (t.title || t.task_type || '') + ' (' + (t.priority || 'normal') + ')' + (t.due_date ? ' — due: ' + t.due_date : '') + '\n';
      });

      prompt += '\n--- EMAILS FROM GMAIL (' + emails.length + ') ---\n';
      emails.forEach(function(e) {
        prompt += e.from + ' → ' + e.to + ' | ' + e.subject + ' | ' + e.date + '\n';
        if (e.snippet) prompt += e.snippet.substring(0, 200) + '\n';
      });

      prompt += '\n--- EMAILS FROM TASK MESSAGES (' + messages.length + ') ---\n';
      messages.forEach(function(m) {
        prompt += '[' + (m.direction || '') + '] ' + (m.subject || '') + ' | ' + (m.sender || m.email_sender || '') + ' | ' + (m.created_at || '') + '\n';
        if (m.body_text) prompt += m.body_text.substring(0, 200) + '\n';
      });

      prompt += '\n--- WHATSAPP (' + dtMessages.length + ') ---\n';
      dtMessages.forEach(function(m) {
        prompt += '[' + (m.direction || 'unknown') + '] ' + (m.message_body || '').substring(0, 200) + ' | ' + (m.created_at || '') + '\n';
      });

      prompt += '\n--- SUPPORT TICKETS (' + tickets.length + ' unresolved) ---\n';
      tickets.forEach(function(t) {
        prompt += '[' + (t.status || '') + '] ' + (t.title || '') + ' (' + (t.category || '') + ')';
        if (t.thread && Array.isArray(t.thread) && t.thread.length > 0) {
          var last = t.thread[t.thread.length - 1];
          prompt += ' — latest: ' + (last.text || '').substring(0, 150);
        }
        prompt += '\n';
      });

      prompt += '\n--- QUALIFICATIONS ---\n';
      prompt += 'Approved: ' + (quals.approved || []).map(function(q) { return q.label || q.key; }).join(', ') + '\n';
      prompt += 'Pending: ' + (quals.uploaded_unverified || []).map(function(q) { return q.label || q.key; }).join(', ') + '\n';
      prompt += 'Missing: ' + (quals.missing || []).map(function(q) { return q.label || q.key; }).join(', ') + '\n';

      prompt += '\n--- RECENT TIMELINE (' + timeline.length + ') ---\n';
      timeline.forEach(function(e) {
        prompt += '[' + (e.event_type || '') + '] ' + (e.title || '') + ' — ' + (e.actor || '') + ' — ' + (e.created_at || '') + '\n';
      });

      prompt += '\n--- PREVIOUS HANDOVER SUMMARY ---\n';
      if (handover) {
        prompt += JSON.stringify(handover, null, 2) + '\n';
      } else {
        prompt += 'No previous summary — this is the first generation for this candidate.\n';
      }

      // 4. Call Claude
      var summarySystemPrompt = 'You are an admin assistant for GP Link, a medical recruitment platform that helps overseas GPs register to work in Australia. You produce concise, actionable intelligence briefs about candidate registration progress.\n\nGiven a candidate\'s case data, communications, tasks, documents, support tickets, and (if available) a previous handover summary, produce a structured JSON summary with these fields:\n\n- overview: 2-4 sentence executive summary. Lead with who they are, where they\'re at, and the single most important thing the admin needs to know. Be specific — name the practice, name the document, quote the message.\n- action_items: Array of strings. Concrete next steps the admin/VA should take. Most urgent first. Include context (e.g. "no reply in 3 days").\n- concerns: Array of strings. Potential problems, delays, red flags. Empty array if none.\n- recent_comms: Array of objects with { channel, direction, summary, sender_or_recipient, age }. Last 5 most relevant communications across all channels. Most recent first.\n- outstanding_requirements: Array of objects with { item, done }. Registration steps and key documents needed. Mark completed ones as done:true.\n- key_history: A condensed paragraph capturing all significant events, resolved issues, and historical context from this candidate\'s entire journey. This field is carried forward into the next summary generation, so include anything a future reader would need to understand the full picture — past blockers that were resolved, important decisions made, escalations, practice changes, etc. If a previous handover exists, preserve its important context and merge with new findings.\n\nRespond with ONLY valid JSON — no markdown fences, no explanation. Be direct and specific. No fluff. If something is overdue or stalling, say so plainly. If there are no concerns, return an empty array — don\'t fabricate issues. If a previous handover summary is provided, use it as historical context — don\'t discard past knowledge, but update it with current findings.';

      var summaryController = new AbortController();
      var summaryTimeout = setTimeout(function() { summaryController.abort(); }, 30000);

      var anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: summaryController.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
          max_tokens: 1024,
          temperature: 0,
          system: [{ type: 'text', text: summarySystemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt }]
        })
      });
      clearTimeout(summaryTimeout);

      if (!anthropicRes.ok) {
        var errText = await anthropicRes.text().catch(function() { return ''; });
        console.error('[AI Summary] Anthropic error:', anthropicRes.status, errText);
        sendJson(res, 502, { ok: false, error: 'AI service returned an error.' });
        return;
      }

      var anthropicData = await anthropicRes.json();
      var inputTokens = (anthropicData.usage && anthropicData.usage.input_tokens) || 0;
      var outputTokens = (anthropicData.usage && anthropicData.usage.output_tokens) || 0;
      var cacheRead = (anthropicData.usage && anthropicData.usage.cache_read_input_tokens) || 0;
      var cacheWrite = (anthropicData.usage && anthropicData.usage.cache_creation_input_tokens) || 0;
      recordAnthropicSpend(inputTokens, outputTokens, cacheRead, cacheWrite);

      var rawText = '';
      if (anthropicData.content && Array.isArray(anthropicData.content)) {
        for (var i = 0; i < anthropicData.content.length; i++) {
          if (anthropicData.content[i].type === 'text') rawText += anthropicData.content[i].text;
        }
      }

      var summary;
      try {
        summary = JSON.parse(rawText.trim());
      } catch (parseErr) {
        // Try to extract JSON from markdown fences
        var jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try { summary = JSON.parse(jsonMatch[1].trim()); } catch (e2) {
            console.error('[AI Summary] Failed to parse AI response:', rawText.substring(0, 500));
            sendJson(res, 502, { ok: false, error: 'AI returned invalid format.' });
            return;
          }
        } else {
          console.error('[AI Summary] Failed to parse AI response:', rawText.substring(0, 500));
          sendJson(res, 502, { ok: false, error: 'AI returned invalid format.' });
          return;
        }
      }

      // 5. Save handover summary to the case record (fire and forget)
      var handoverPayload = {
        overview: summary.overview || '',
        action_items: summary.action_items || [],
        concerns: summary.concerns || [],
        key_history: summary.key_history || '',
        generated_at: new Date().toISOString()
      };
      supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), {
        method: 'PATCH',
        body: { ai_handover_summary: handoverPayload }
      }).catch(function(err) {
        console.error('[AI Summary] Failed to save handover:', err.message);
      });

      sendJson(res, 200, {
        ok: true,
        summary: summary,
        meta: {
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
          generated_at: new Date().toISOString(),
          input_tokens: inputTokens,
          output_tokens: outputTokens
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        sendJson(res, 504, { ok: false, error: 'AI summary timed out. Please try again.' });
      } else {
        console.error('[AI Summary] Unexpected error:', err);
        sendJson(res, 500, { ok: false, error: 'Summary generation failed.' });
      }
    }
    return;
  }
```

- [ ] **Step 2: Verify the server starts without errors**

Run: `npm start` — confirm no syntax errors on startup, then kill the server.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add /api/admin/candidate-summary endpoint with AI aggregation"
```

---

### Task 3: Frontend — CSS Styles for AI Summary Card

**Files:**
- Modify: `pages/admin.html` (insert CSS after the Journey Rail styles, around line 862)

- [ ] **Step 1: Add CSS styles**

Insert after line 862 (after the `.jr-arrow.pending` rule), before the `/* ── Stage Groups ── */` comment:

```css
/* ── AI Summary Card ── */
.ai-summary-card{background:linear-gradient(135deg,var(--panel),var(--bg2));border:1px solid var(--blue);border-radius:var(--radius);padding:14px 16px;margin-bottom:8px;position:relative;overflow:hidden}
.ai-summary-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--blue),var(--purple-1))}
.ai-summary-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.ai-summary-title{display:flex;align-items:center;gap:6px;font-weight:800;font-size:13px;color:var(--blue)}
.ai-summary-actions{display:flex;align-items:center;gap:8px}
.ai-summary-actions .ai-ts{font-size:10px;color:var(--muted)}
.ai-summary-actions .ai-refresh{font-size:11px;color:var(--blue);cursor:pointer;background:none;border:none;padding:2px 4px;font-weight:600}
.ai-summary-actions .ai-refresh:hover{text-decoration:underline}
.ai-summary-overview{font-size:12.5px;line-height:1.6;color:var(--text);margin-bottom:10px}
.ai-summary-pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.ai-pill{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600}
.ai-pill.actions{background:rgba(245,158,11,.15);color:var(--amber,#f59e0b)}
.ai-pill.concerns{background:rgba(239,68,68,.15);color:var(--red,#ef4444)}
.ai-pill.tickets{background:rgba(34,197,94,.15);color:var(--green,#22c55e)}
.ai-pill.concerns-active{background:rgba(239,68,68,.15);color:var(--red,#ef4444)}
.ai-pill.tickets-active{background:rgba(239,68,68,.15);color:var(--red,#ef4444)}
.ai-summary-toggle{text-align:center;padding-top:8px;border-top:1px dashed var(--line)}
.ai-summary-toggle button{font-size:12px;color:var(--blue);cursor:pointer;background:none;border:none;font-weight:500;padding:4px 8px}
.ai-summary-toggle button:hover{text-decoration:underline}
.ai-summary-detail{overflow:hidden;max-height:0;transition:max-height .3s ease;opacity:0;transition:max-height .3s ease, opacity .2s ease}
.ai-summary-detail.open{max-height:2000px;opacity:1}
.ai-summary-detail hr{border:none;border-top:1px solid var(--line);margin:12px 0}
.ai-summary-section{margin-bottom:12px}
.ai-summary-section-title{font-weight:700;font-size:12px;margin-bottom:6px}
.ai-summary-section-title.action{color:var(--amber,#f59e0b)}
.ai-summary-section-title.concern{color:var(--red,#ef4444)}
.ai-summary-section-title.comms{color:var(--blue)}
.ai-summary-section-title.reqs{color:var(--green)}
.ai-summary-section ul{margin:0;padding-left:16px;font-size:12px;color:var(--text);line-height:1.8}
.ai-summary-section .comms-line{font-size:12px;color:var(--text);line-height:1.8}
.ai-summary-section .comms-age{color:var(--muted)}
.ai-summary-section .req-done{color:var(--muted);text-decoration:line-through}
.ai-summary-loading{text-align:center;padding:20px;color:var(--muted);font-size:12px}
.ai-summary-loading .ai-spinner{display:inline-block;width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--blue);border-radius:50%;animation:aispin .6s linear infinite;margin-right:8px;vertical-align:middle}
@keyframes aispin{to{transform:rotate(360deg)}}
.ai-summary-error{text-align:center;padding:14px;color:var(--muted);font-size:12px}
.ai-summary-error .ai-retry{color:var(--blue);cursor:pointer;background:none;border:none;font-weight:600;margin-top:6px;font-size:12px}
```

- [ ] **Step 2: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add CSS styles for AI summary card"
```

---

### Task 4: Frontend — `renderAiSummary()` Function and Integration

**Files:**
- Modify: `pages/admin.html` (add function before `renderDetail()` at line 2918, and modify `renderDetail()` to call it)

- [ ] **Step 1: Add the `renderAiSummary` function**

Insert before line 2918 (before `function renderDetail(){`):

```javascript
  function renderAiSummary(caseId, container) {
    if (!container) return;
    // Loading state
    container.innerHTML = '<div class="ai-summary-card"><div class="ai-summary-loading"><span class="ai-spinner"></span>Generating AI summary\u2026</div></div>';

    fetch('/api/admin/candidate-summary?case_id=' + encodeURIComponent(caseId), { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.ok || !data.summary) {
          container.innerHTML = '<div class="ai-summary-card"><div class="ai-summary-error">' + esc(data.error || 'Unable to generate AI summary.') + '<br><button class="ai-retry" data-ai-retry="' + esc(caseId) + '">Retry</button></div></div>';
          return;
        }
        var s = data.summary;
        var actionCount = (s.action_items || []).length;
        var concernCount = (s.concerns || []).length;
        var ticketPill = '';
        // Ticket count from concerns or from the data
        var html = '<div class="ai-summary-card">';
        // Header
        html += '<div class="ai-summary-header">';
        html += '<div class="ai-summary-title">\u2728 AI Summary</div>';
        html += '<div class="ai-summary-actions">';
        if (data.meta && data.meta.generated_at) {
          var ago = _aiTimeAgo(data.meta.generated_at);
          html += '<span class="ai-ts">' + esc(ago) + '</span>';
        }
        html += '<button class="ai-refresh" data-ai-retry="' + esc(caseId) + '">\u21BB Refresh</button>';
        html += '</div></div>';

        // Overview
        html += '<div class="ai-summary-overview">' + esc(s.overview || '') + '</div>';

        // Pills
        html += '<div class="ai-summary-pills">';
        html += '<span class="ai-pill actions">' + actionCount + ' action' + (actionCount !== 1 ? 's' : '') + ' needed</span>';
        if (concernCount > 0) {
          html += '<span class="ai-pill concerns-active">' + concernCount + ' concern' + (concernCount !== 1 ? 's' : '') + '</span>';
        } else {
          html += '<span class="ai-pill tickets">No concerns</span>';
        }
        html += '</div>';

        // Collapsible detail section
        html += '<div class="ai-summary-detail" id="aiSummaryDetail">';
        html += '<hr>';

        // Action Items
        if (actionCount > 0) {
          html += '<div class="ai-summary-section"><div class="ai-summary-section-title action">\u26A1 Action Items</div><ul>';
          s.action_items.forEach(function(item) { html += '<li>' + esc(item) + '</li>'; });
          html += '</ul></div>';
        }

        // Concerns
        if (concernCount > 0) {
          html += '<div class="ai-summary-section"><div class="ai-summary-section-title concern">\u26A0 Concerns</div><ul>';
          s.concerns.forEach(function(item) { html += '<li>' + esc(item) + '</li>'; });
          html += '</ul></div>';
        }

        // Recent Comms
        if (s.recent_comms && s.recent_comms.length > 0) {
          html += '<div class="ai-summary-section"><div class="ai-summary-section-title comms">\uD83D\uDCAC Recent Communications</div>';
          s.recent_comms.forEach(function(c) {
            var icon = c.channel === 'whatsapp' ? '\uD83D\uDCAC' : c.channel === 'email' ? '\uD83D\uDCE7' : '\uD83D\uDCDD';
            var who = c.direction === 'inbound' ? (c.sender_or_recipient || c.sender || 'GP') : (c.sender_or_recipient || c.recipient || '');
            html += '<div class="comms-line">' + icon + ' <strong>' + esc(who) + ':</strong> ' + esc(c.summary || '') + ' <span class="comms-age">\u2014 ' + esc(c.age || '') + '</span></div>';
          });
          html += '</div>';
        }

        // Outstanding Requirements
        if (s.outstanding_requirements && s.outstanding_requirements.length > 0) {
          html += '<div class="ai-summary-section"><div class="ai-summary-section-title reqs">\uD83D\uDCCB Outstanding Requirements</div>';
          s.outstanding_requirements.forEach(function(r) {
            if (r.done) {
              html += '<div class="req-done">\u2611 ' + esc(r.item) + '</div>';
            } else {
              html += '<div>\u2610 ' + esc(r.item) + '</div>';
            }
          });
          html += '</div>';
        }

        html += '</div>'; // close detail

        // Toggle
        html += '<div class="ai-summary-toggle"><button data-ai-toggle>\u25BC Show details</button></div>';
        html += '</div>'; // close card
        container.innerHTML = html;
      })
      .catch(function(err) {
        console.error('[AI Summary] fetch error:', err);
        container.innerHTML = '<div class="ai-summary-card"><div class="ai-summary-error">Failed to load AI summary.<br><button class="ai-retry" data-ai-retry="' + esc(caseId) + '">Retry</button></div></div>';
      });
  }

  function _aiTimeAgo(isoStr) {
    var diff = Date.now() - new Date(isoStr).getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }
```

- [ ] **Step 2: Modify `renderDetail()` to include the AI summary container and trigger fetch**

In `renderDetail()`, change the `el.innerHTML` template (around line 2974) to include an AI summary container between profileBarHtml and renderJourneyRail:

Replace:
```javascript
      el.innerHTML=`
        <button class="btn sm" data-gp-back style="margin-bottom:8px;display:none">\u2190 Back</button>
        ${profileBarHtml}
        ${renderJourneyRail(c)}
        ${tabsBar}
        <div class="gp-detail-tab-pane">${paneHtml}</div>
      `;
```

With:
```javascript
      el.innerHTML=`
        <button class="btn sm" data-gp-back style="margin-bottom:8px;display:none">\u2190 Back</button>
        ${profileBarHtml}
        <div id="aiSummaryContainer"></div>
        ${renderJourneyRail(c)}
        ${tabsBar}
        <div class="gp-detail-tab-pane">${paneHtml}</div>
      `;
      renderAiSummary(c.id, document.getElementById('aiSummaryContainer'));
```

- [ ] **Step 3: Add event delegation for toggle and refresh/retry buttons**

Find the main event delegation block (the `document.addEventListener('click', ...)` handler, around line 4909). Add handlers for `data-ai-toggle` and `data-ai-retry` inside the existing click handler:

```javascript
    // AI Summary toggle
    var aiToggle = e.target.closest('[data-ai-toggle]');
    if (aiToggle) {
      var detail = document.getElementById('aiSummaryDetail');
      if (detail) {
        var isOpen = detail.classList.toggle('open');
        aiToggle.textContent = isOpen ? '\u25B2 Hide details' : '\u25BC Show details';
      }
      return;
    }

    // AI Summary refresh/retry
    var aiRetry = e.target.closest('[data-ai-retry]');
    if (aiRetry) {
      var retryCaseId = aiRetry.getAttribute('data-ai-retry');
      var container = document.getElementById('aiSummaryContainer');
      if (retryCaseId && container) renderAiSummary(retryCaseId, container);
      return;
    }
```

- [ ] **Step 4: Verify the server starts and the card renders**

Run: `npm start` — open admin panel, navigate to a GP candidate, confirm:
1. Loading spinner appears in the AI summary card area
2. After AI response: overview paragraph, pills, and "Show details" toggle render
3. Clicking "Show details" expands to show Action Items, Concerns, Comms, Requirements
4. Clicking "Hide details" collapses back
5. "Refresh" button re-fetches the summary
6. If API fails: error state with "Retry" button appears

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add AI summary card to admin candidate detail view"
```

---

### Task 5: Push and Verify

**Files:** None (git operations only)

- [ ] **Step 1: Push all commits**

```bash
git push
```

- [ ] **Step 2: Run the Supabase migration on production**

The migration needs to be applied to add the `ai_handover_summary` column. Run:

```bash
npx supabase db push
```

Or apply manually via Supabase dashboard SQL editor:
```sql
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ai_handover_summary JSONB DEFAULT NULL;
```

- [ ] **Step 3: Deploy to Vercel**

```bash
vercel --prod
```

- [ ] **Step 4: Verify on production**

Open the admin panel on production, navigate to a candidate with existing case data, and confirm the AI summary card loads and generates correctly.
