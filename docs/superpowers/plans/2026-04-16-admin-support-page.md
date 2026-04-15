# VA Admin Support Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Support" tab to the VA admin dashboard showing a single filterable list that merges support_tickets and DoubleTick whatsapp_help tasks.

**Architecture:** New `GET /api/admin/va/support` endpoint merges both data sources into a normalized shape. Frontend adds a Support tab between Applications and Tools, with source (All/WhatsApp/Manual) and status (Open/Closed/All) filters. Clicking a row expands inline to show full details + resolve action.

**Tech Stack:** Vanilla JS/HTML (inline in admin.html), Node.js API endpoint in server.js, Supabase PostgREST queries.

---

### Task 1: Add the API endpoint `GET /api/admin/va/support`

**Files:**
- Modify: `server.js` — add new endpoint near the existing `/api/admin/va/tickets` route (~line 18128)

- [ ] **Step 1: Add the route match and handler**

Insert this block just BEFORE the existing `/api/admin/va/tickets` route (around line 18128 in server.js). Find the line:

```javascript
  if (pathname === '/api/admin/va/tickets' && req.method === 'GET') {
```

Insert this new block BEFORE it:

```javascript
  // ── GET /api/admin/va/support ─────────────────────────────────────────────
  // Merged view: support_tickets + whatsapp_help registration_tasks
  if (pathname === '/api/admin/va/support' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    const sourceFilter = (url.searchParams.get('source') || 'all').toLowerCase(); // all | whatsapp | manual
    const statusFilter = (url.searchParams.get('status') || 'open').toLowerCase(); // all | open | closed

    const items = [];

    // ── 1. Support tickets (source = "manual") ───────────────────────────
    if (sourceFilter === 'all' || sourceFilter === 'manual') {
      const stQuery = statusFilter === 'all'
        ? 'select=*&order=created_at.desc&limit=500'
        : statusFilter === 'closed'
          ? 'select=*&status=eq.closed&order=resolved_at.desc.nullslast,updated_at.desc&limit=500'
          : 'select=*&status=neq.closed&order=created_at.desc&limit=500';
      const stRes = await supabaseDbRequest('support_tickets', stQuery);
      const tickets = stRes.ok && Array.isArray(stRes.data) ? stRes.data : [];
      for (const tk of tickets) {
        items.push({
          id: tk.id,
          kind: 'ticket',
          source: 'manual',
          user_id: tk.user_id,
          case_id: tk.case_id || null,
          title: tk.title || 'Support request',
          body: tk.body || '',
          category: tk.category || null,
          stage: tk.stage || '',
          priority: tk.priority || 'normal',
          status: tk.status || 'open',
          doubletick_url: null,
          resolved_at: tk.resolved_at || null,
          resolved_by: tk.resolved_by || null,
          created_at: tk.created_at,
          updated_at: tk.updated_at
        });
      }
    }

    // ── 2. WhatsApp help tasks (source = "whatsapp") ─────────────────────
    if (sourceFilter === 'all' || sourceFilter === 'whatsapp') {
      const waStatusClause = statusFilter === 'all'
        ? ''
        : statusFilter === 'closed'
          ? '&status=in.(completed,cancelled)'
          : '&status=in.(open,in_progress,waiting)';
      const waQuery = 'select=*&task_type=eq.whatsapp_help&source_trigger=eq.doubletick_webhook' + waStatusClause + '&order=created_at.desc&limit=500';
      const waRes = await supabaseDbRequest('registration_tasks', waQuery);
      const waTasks = waRes.ok && Array.isArray(waRes.data) ? waRes.data : [];
      for (const t of waTasks) {
        items.push({
          id: t.id,
          kind: 'task',
          source: 'whatsapp',
          user_id: null,
          case_id: t.case_id || null,
          title: t.title || 'WhatsApp enquiry',
          body: t.description || '',
          category: null,
          stage: t.related_stage || '',
          priority: t.priority || 'high',
          status: t.status === 'completed' || t.status === 'cancelled' ? 'closed' : t.status || 'open',
          doubletick_url: t.doubletick_conversation_url || null,
          resolved_at: t.completed_at || null,
          resolved_by: t.completed_by || null,
          created_at: t.created_at,
          updated_at: t.updated_at
        });
      }
    }

    // ── 3. Enrich with GP profile data ───────────────────────────────────
    // Collect case_ids to resolve user_ids for whatsapp tasks
    const caseIds = [...new Set(items.filter(i => i.case_id && !i.user_id).map(i => i.case_id))];
    let caseUserMap = {};
    if (caseIds.length > 0) {
      const cRes = await supabaseDbRequest('registration_cases', 'select=id,user_id&id=in.(' + caseIds.map(encodeURIComponent).join(',') + ')');
      if (cRes.ok && Array.isArray(cRes.data)) cRes.data.forEach(c => { caseUserMap[c.id] = c.user_id; });
      // Back-fill user_id on whatsapp items
      for (const item of items) {
        if (!item.user_id && item.case_id && caseUserMap[item.case_id]) {
          item.user_id = caseUserMap[item.case_id];
        }
      }
    }

    const userIds = [...new Set(items.map(i => i.user_id).filter(Boolean))];
    let profileMap = {};
    if (userIds.length > 0) {
      const pRes = await supabaseDbRequest('user_profiles', 'select=user_id,first_name,last_name,email,phone_number,phone&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')');
      if (pRes.ok && Array.isArray(pRes.data)) pRes.data.forEach(p => { profileMap[p.user_id] = p; });
    }

    const enriched = items.map(item => {
      const p = profileMap[item.user_id] || {};
      return Object.assign({}, item, {
        gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || 'Unknown',
        gp_email: p.email || '',
        gp_phone: p.phone_number || p.phone || '',
        whatsapp_link: buildWhatsAppLink(item.stage, p.first_name || '')
      });
    });

    // Sort: open first, then by created_at desc
    enriched.sort((a, b) => {
      const aOpen = a.status !== 'closed' ? 0 : 1;
      const bOpen = b.status !== 'closed' ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    sendJson(res, 200, { ok: true, items: enriched });
    return;
  }
```

- [ ] **Step 2: Add route to resolve/close a whatsapp_help task**

Find the existing ticket PUT handler (`vaTicketMatch` around line 18157). After the closing `}` of that handler block, add:

```javascript
  // ── PUT /api/admin/va/support/task/:id — resolve a whatsapp_help task ──
  const supportTaskMatch = pathname.match(/^\/api\/admin\/va\/support\/task\/([^/]+)$/);
  if (supportTaskMatch && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const taskId = decodeURIComponent(supportTaskMatch[1] || '');
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const nextStatus = body && body.status === 'completed' ? 'completed' : body && body.status === 'open' ? 'open' : null;
    if (!nextStatus) { sendJson(res, 400, { ok: false, message: 'status must be open or completed.' }); return; }
    const patch = { status: nextStatus, updated_at: new Date().toISOString() };
    if (nextStatus === 'completed') { patch.completed_at = new Date().toISOString(); patch.completed_by = adminCtx.email; }
    else { patch.completed_at = null; patch.completed_by = null; }
    const r = await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId) + '&task_type=eq.whatsapp_help', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    const updated = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
    if (!updated) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, task: updated });
    return;
  }
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(admin): add GET /api/admin/va/support + PUT task resolve endpoint"
git push
```

---

### Task 2: Add Support tab and panel to admin.html

**Files:**
- Modify: `pages/admin.html` — add tab, panel div, CSS, vaShowPanel update, tab click handler

- [ ] **Step 1: Add the "Support" tab**

Find the view-tabs div (line 548-554):
```html
      <div class="view-tab" data-view="applications">Applications</div>
      <div class="view-tab" data-view="tools">Tools</div>
```

Insert the Support tab between Applications and Tools:
```html
      <div class="view-tab" data-view="applications">Applications</div>
      <div class="view-tab" data-view="support">Support</div>
      <div class="view-tab" data-view="tools">Tools</div>
```

- [ ] **Step 2: Add the panel div**

Find the applications panel div (around line 569):
```html
  <div class="applications-wrap" id="applicationsPanel" style="display:none"></div>
```

Insert after it:
```html
  <div class="support-wrap" id="supportPanel" style="display:none"></div>
```

- [ ] **Step 3: Add CSS styles**

Find the existing `.tickets-wrap` CSS block (around line 388). Add after it:

```css
    .support-wrap{padding:16px;overflow:auto;height:100%}
    .support-filters{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}
    .support-filter-group{display:flex;gap:2px;background:var(--bg);border-radius:var(--radius);padding:2px}
    .support-filter-btn{padding:6px 12px;font-size:11px;font-weight:700;color:var(--muted);cursor:pointer;border:none;background:none;border-radius:calc(var(--radius) - 2px);transition:all .15s}
    .support-filter-btn.active{background:#fff;color:var(--blue);box-shadow:var(--shadow)}
    .support-table{width:100%;border-collapse:collapse;font-size:12px}
    .support-table th{text-align:left;padding:8px 10px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:2px solid var(--line);position:sticky;top:0;background:#fff;z-index:1}
    .support-table td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
    .support-table tr:hover{background:var(--bg)}
    .support-table tr[data-support-id]{cursor:pointer}
    .support-source-badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.02em}
    .support-source-badge.whatsapp{background:#dcfce7;color:#15803d}
    .support-source-badge.manual{background:#dbeafe;color:#1d4ed8}
    .support-priority-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
    .support-priority-dot.urgent{background:#ef4444}
    .support-priority-dot.high{background:#f59e0b}
    .support-priority-dot.normal{background:#6b7280}
    .support-priority-dot.low{background:#d1d5db}
    .support-expand{background:var(--bg);border-top:none}
    .support-expand td{padding:12px 10px 16px}
    .support-expand-body{font-size:12px;line-height:1.5;margin-bottom:10px;white-space:pre-wrap;max-height:200px;overflow:auto}
    .support-expand-meta{font-size:11px;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px}
    .support-expand-actions{display:flex;gap:6px;flex-wrap:wrap}
    .support-status-open{color:#15803d;font-weight:700}
    .support-status-closed{color:var(--muted);font-weight:700}
    .support-empty{text-align:center;padding:40px 20px;color:var(--muted);font-size:13px}
    .support-count{font-size:11px;color:var(--muted);margin-left:auto}
```

- [ ] **Step 4: Update vaShowPanel to include supportPanel**

Find the vaShowPanel function (around line 2530):
```javascript
  function vaShowPanel(which){
    document.getElementById("mainLayout").style.display=(which==="gps"?"grid":"none");
    const panels={"inboxPanel":"inbox","interviewsPanel":"interviews","applicationsPanel":"applications","toolsPanel":"tools"};
    Object.keys(panels).forEach(function(id){var el=document.getElementById(id);if(el)el.style.display=(panels[id]===which?"block":"none");});
  }
```

Replace with:
```javascript
  function vaShowPanel(which){
    document.getElementById("mainLayout").style.display=(which==="gps"?"grid":"none");
    const panels={"inboxPanel":"inbox","interviewsPanel":"interviews","applicationsPanel":"applications","supportPanel":"support","toolsPanel":"tools"};
    Object.keys(panels).forEach(function(id){var el=document.getElementById(id);if(el)el.style.display=(panels[id]===which?"block":"none");});
  }
```

- [ ] **Step 5: Add the tab click handler case for "support"**

Find the tab click handler (around line 2196-2214). Locate:
```javascript
      }else if(view==="applications"){
        await loadAdminApplications();
      }else if(view==="tools"){
```

Insert the support case between applications and tools:
```javascript
      }else if(view==="applications"){
        await loadAdminApplications();
      }else if(view==="support"){
        await loadSupportItems();
        renderSupportPanel();
      }else if(view==="tools"){
```

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html
git commit -m "feat(admin): add Support tab skeleton + CSS to admin dashboard"
git push
```

---

### Task 3: Add the data loading and rendering logic

**Files:**
- Modify: `pages/admin.html` — add state, fetch, render functions to the inline `<script>`

- [ ] **Step 1: Add state fields**

Find the state object S initialization (around line 635). Locate:
```javascript
    va:{dashboard:null,tickets:[],ticketsView:"open",
```

Replace with:
```javascript
    va:{dashboard:null,tickets:[],ticketsView:"open",supportItems:[],supportSource:"all",supportStatus:"open",supportExpandedId:null,
```

- [ ] **Step 2: Add the loadSupportItems function**

Insert this function near the other load functions (after `loadVaDashboard` around line 2521):

```javascript
  async function loadSupportItems(){
    try{
      const params=new URLSearchParams({source:S.va.supportSource,status:S.va.supportStatus});
      const r=await fetch("/api/admin/va/support?"+params,{credentials:"same-origin"});
      if(r.status===401){window.location.href="/pages/admin-signin.html";return;}
      const d=await r.json().catch(()=>({}));
      if(d&&d.ok){S.va.supportItems=d.items||[];}
      else{S.va.supportItems=[];toast((d&&d.message)||"Failed to load support items","red");}
    }catch(err){console.error("[VA] loadSupportItems failed",err);S.va.supportItems=[];}
  }
```

- [ ] **Step 3: Add the renderSupportPanel function**

Insert after `loadSupportItems`:

```javascript
  function renderSupportPanel(){
    const el=document.getElementById("supportPanel");if(!el)return;
    const items=S.va.supportItems||[];
    const src=S.va.supportSource||"all";
    const st=S.va.supportStatus||"open";

    function filterBtn(group,value,label){
      const active=(group==="source"?src:st)===value?"active":"";
      return '<button class="support-filter-btn '+active+'" data-support-filter-group="'+esc(group)+'" data-support-filter-value="'+esc(value)+'">'+esc(label)+'</button>';
    }

    let h='<div class="support-filters">';
    h+='<div class="support-filter-group">'+filterBtn("source","all","All")+filterBtn("source","whatsapp","WhatsApp")+filterBtn("source","manual","Manual")+'</div>';
    h+='<div class="support-filter-group">'+filterBtn("status","open","Open")+filterBtn("status","closed","Closed")+filterBtn("status","all","All")+'</div>';
    h+='<div class="support-count">'+items.length+' item'+(items.length!==1?'s':'')+'</div>';
    h+='</div>';

    if(items.length===0){
      h+='<div class="support-empty">No support items match the current filters.</div>';
      el.innerHTML=h;return;
    }

    h+='<table class="support-table"><thead><tr>';
    h+='<th>GP</th><th>Source</th><th>Title</th><th>Stage</th><th>Priority</th><th>Status</th><th>Date</th>';
    h+='</tr></thead><tbody>';

    for(const item of items){
      const isExpanded=S.va.supportExpandedId===item.id;
      const srcBadge=item.source==="whatsapp"
        ?'<span class="support-source-badge whatsapp">WhatsApp</span>'
        :'<span class="support-source-badge manual">Manual</span>';
      const priDot='<span class="support-priority-dot '+esc(item.priority||"normal")+'"></span>'+esc(item.priority||"normal");
      const statusCls=item.status==="closed"?"support-status-closed":"support-status-open";
      const statusLabel=item.status==="closed"?"Closed":(item.status==="in_progress"?"In Progress":(item.status==="waiting_on_gp"?"Waiting on GP":"Open"));

      h+='<tr data-support-id="'+esc(item.id)+'" data-support-kind="'+esc(item.kind)+'">';
      h+='<td><strong>'+esc(item.gp_name||"Unknown")+'</strong></td>';
      h+='<td>'+srcBadge+'</td>';
      h+='<td>'+esc(item.title||"")+'</td>';
      h+='<td>'+esc(item.stage||"—")+'</td>';
      h+='<td>'+priDot+'</td>';
      h+='<td><span class="'+statusCls+'">'+statusLabel+'</span></td>';
      h+='<td>'+fmtR(item.created_at)+'</td>';
      h+='</tr>';

      if(isExpanded){
        h+='<tr class="support-expand"><td colspan="7">';
        h+='<div class="support-expand-body">'+esc(item.body||"No message body.")+'</div>';
        h+='<div class="support-expand-meta">';
        if(item.gp_email)h+='<span>Email: '+esc(item.gp_email)+'</span>';
        if(item.gp_phone)h+='<span>Phone: '+esc(item.gp_phone)+'</span>';
        if(item.category)h+='<span>Category: '+esc(item.category)+'</span>';
        if(item.resolved_by)h+='<span>Resolved by: '+esc(item.resolved_by)+'</span>';
        if(item.resolved_at)h+='<span>Resolved: '+fmtR(item.resolved_at)+'</span>';
        h+='</div>';
        h+='<div class="support-expand-actions">';
        if(item.whatsapp_link)h+='<a class="btn wa" href="'+safeUrl(item.whatsapp_link)+'" target="_blank" rel="noopener">WhatsApp</a>';
        if(item.doubletick_url)h+='<a class="btn" href="'+safeUrl(item.doubletick_url)+'" target="_blank" rel="noopener">DoubleTick</a>';
        if(item.status!=="closed"){
          h+='<button class="btn primary sm" data-support-resolve="'+esc(item.id)+'" data-support-kind="'+esc(item.kind)+'">Resolve & Close</button>';
        }else{
          h+='<button class="btn sm" data-support-reopen="'+esc(item.id)+'" data-support-kind="'+esc(item.kind)+'">Reopen</button>';
        }
        h+='</div>';
        h+='</td></tr>';
      }
    }

    h+='</tbody></table>';
    el.innerHTML=h;
  }
```

- [ ] **Step 4: Add event delegation for filter buttons, row expansion, and resolve/reopen**

Find the main event delegation block (the document-level click handler, around line 2830-2850). Add these handlers inside it:

```javascript
    // ── Support panel: filter buttons ───────────────────────────────────
    const sfBtn=e.target.closest("[data-support-filter-group]");
    if(sfBtn){
      e.preventDefault();
      const group=sfBtn.getAttribute("data-support-filter-group");
      const value=sfBtn.getAttribute("data-support-filter-value");
      if(group==="source")S.va.supportSource=value;
      else if(group==="status")S.va.supportStatus=value;
      S.va.supportExpandedId=null;
      await loadSupportItems();
      renderSupportPanel();
      return;
    }

    // ── Support panel: row expand/collapse ──────────────────────────────
    const sRow=e.target.closest("[data-support-id]");
    if(sRow&&!e.target.closest("a,button")){
      const id=sRow.getAttribute("data-support-id");
      S.va.supportExpandedId=S.va.supportExpandedId===id?null:id;
      renderSupportPanel();
      return;
    }

    // ── Support panel: resolve & close ──────────────────────────────────
    const sResolve=e.target.closest("[data-support-resolve]");
    if(sResolve){
      e.preventDefault();e.stopPropagation();
      const id=sResolve.getAttribute("data-support-resolve");
      const kind=sResolve.getAttribute("data-support-kind");
      await supportAction(id,kind,"close");
      return;
    }

    // ── Support panel: reopen ───────────────────────────────────────────
    const sReopen=e.target.closest("[data-support-reopen]");
    if(sReopen){
      e.preventDefault();e.stopPropagation();
      const id=sReopen.getAttribute("data-support-reopen");
      const kind=sReopen.getAttribute("data-support-kind");
      await supportAction(id,kind,"reopen");
      return;
    }
```

- [ ] **Step 5: Add the supportAction helper function**

Insert near the `closeTicketAction` function (around line 2765):

```javascript
  async function supportAction(id,kind,action){
    try{
      let url,body;
      if(kind==="ticket"){
        url="/api/admin/va/ticket/"+encodeURIComponent(id);
        body={status:action==="close"?"closed":"open"};
      }else{
        url="/api/admin/va/support/task/"+encodeURIComponent(id);
        body={status:action==="close"?"completed":"open"};
      }
      const r=await fetch(url,{method:"PUT",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const d=await r.json().catch(()=>({}));
      if(d&&d.ok){
        toast(action==="close"?"Resolved":"Reopened");
        await loadSupportItems();
        renderSupportPanel();
      }else{toast((d&&d.message)||"Failed","red");}
    }catch{toast("Network error","red");}
  }
```

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html
git commit -m "feat(admin): add Support page rendering, filters, and resolve actions"
git push
```

---

### Task 4: Test end-to-end and clean up debug logging

**Files:**
- Modify: `server.js` — remove debug logging from DoubleTick webhook handler

- [ ] **Step 1: Verify the Support page works**

Open the admin dashboard in the browser, click the Support tab. Verify:
- The two existing WhatsApp help tasks appear (one open, one completed)
- Source filter toggles correctly (All shows both, WhatsApp shows both, Manual shows none since no manual tickets exist)
- Status filter works (Open shows 1, Closed shows 1, All shows 2)
- Clicking a row expands to show the message body, GP details, and action buttons
- Resolve & Close button works on the open task
- Reopen button works on the closed task

- [ ] **Step 2: Remove debug logging from DoubleTick webhook**

In `server.js`, find and remove the raw payload debug log (around line 1925):
```javascript
  // Log raw payload so we can see what DoubleTick actually sends
  console.log('[doubletick-webhook] Raw payload:', JSON.stringify(body).slice(0, 2000));
```

Remove the classification debug logs (around line 1940-1943):
```javascript
  console.log('[doubletick-webhook] Classifying message from', fromPhone, (contactName ? '(' + contactName + ')' : ''), ':', messageBody.slice(0, 200));
```
and:
```javascript
  console.log('[doubletick-webhook] Classification result:', isHelpRequest ? 'HELP' : 'IGNORED');
```

Keep the warning-level logs (sanitize rejected, no active case, AI classify failed) — those are useful for ongoing monitoring.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "chore: remove DoubleTick webhook debug logging after confirming fix"
git push
```
