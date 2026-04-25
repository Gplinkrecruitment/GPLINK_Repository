# Admin Medical Centres + Vaulted Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vault (hide+disable) Interviews, Applications, Support, Tools tabs from admin nav; add a new Medical Centres tab showing practices with Zoho Recruit job openings; relocate super-admin tools behind a gear icon.

**Architecture:** All changes are in two files: `pages/admin.html` (frontend) and `server.js` (two new API endpoints). The Medical Centres data comes from the existing `career_roles` table (already synced from Zoho Recruit). Applications data comes from the existing `gp_applications` table. Benefits are extracted from `career_roles.source_payload.zoho` (Benefit_1/2/3 fields). No new DB migrations needed.

**Tech Stack:** Vanilla JS/HTML (existing pattern), Supabase REST API, Node.js server

---

### Task 1: Vault the four tabs from admin nav

Remove Interviews, Applications, Support, and Tools tabs and their view panels from the HTML. Remove their JS handlers from the tab-switch listener.

**Files:**
- Modify: `pages/admin.html:630-637` (nav tabs)
- Modify: `pages/admin.html:651-738` (view panels)
- Modify: `pages/admin.html:2495-2516` (tab click handler)
- Modify: `pages/admin.html:2990-2998` (vaShowPanel + vaHidePanels)

- [ ] **Step 1: Remove the four tab elements from the nav bar**

In `pages/admin.html`, replace lines 630-637:

```html
  <div class="view-tabs">
    <div class="view-tab active" data-view="inbox">Inbox</div>
    <div class="view-tab" data-view="gps">GPs</div>
    <div class="view-tab" data-view="interviews">Interviews</div>
    <div class="view-tab" data-view="applications">Applications</div>
    <div class="view-tab" data-view="support">Support</div>
    <div class="view-tab" data-view="tools">Tools</div>
  </div>
```

With:

```html
  <div class="view-tabs">
    <div class="view-tab active" data-view="inbox">Inbox</div>
    <div class="view-tab" data-view="gps">GPs</div>
    <div class="view-tab" data-view="medicalcentres">Medical Centres</div>
  </div>
```

- [ ] **Step 2: Remove the four vaulted view panels, keep inboxPanel**

Replace lines 651-738 (the interviewsPanel, applicationsPanel, supportPanel, toolsPanel divs and everything inside toolsPanel including the Zoho Sign integration card) with just a new medicalCentresPanel:

```html
  <div class="medical-centres-wrap" id="medicalCentresPanel" style="display:none"></div>
```

Keep lines 650 (`inboxPanel`) and 739+ (SPPA review overlay etc.) untouched.

- [ ] **Step 3: Update the tab click handler**

Replace the tab click handler at lines 2495-2516:

```javascript
    document.querySelector(".view-tabs").addEventListener("click",async e=>{
      const tab=e.target.closest("[data-view]");if(!tab)return;
      const view=tab.getAttribute("data-view");
      S.view=view;
      document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t===tab));
      vaShowPanel(view);
      if(view==="inbox"){
        if(!S.va.dashboard)await loadVaDashboard();
        renderInboxPanel();
      }else if(view==="gps"){
        renderCaseList();renderDetail();
      }else if(view==="interviews"){
        await loadInterviews();
      }else if(view==="applications"){
        await loadAdminApplications();
      }else if(view==="support"){
        await loadSupportItems();
        renderSupportPanel();
      }else if(view==="tools"){
        renderToolsPanel();
      }
    });
```

With:

```javascript
    document.querySelector(".view-tabs").addEventListener("click",async e=>{
      const tab=e.target.closest("[data-view]");if(!tab)return;
      const view=tab.getAttribute("data-view");
      S.view=view;
      document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t===tab));
      vaShowPanel(view);
      if(view==="inbox"){
        if(!S.va.dashboard)await loadVaDashboard();
        renderInboxPanel();
      }else if(view==="gps"){
        renderCaseList();renderDetail();
      }else if(view==="medicalcentres"){
        await loadMedicalCentres();
      }
    });
```

- [ ] **Step 4: Update vaShowPanel and vaHidePanels**

Replace the `vaShowPanel` function at line 2990-2994:

```javascript
  function vaShowPanel(which){
    document.getElementById("mainLayout").style.display=(which==="gps"?"grid":"none");
    const panels={"inboxPanel":"inbox","interviewsPanel":"interviews","applicationsPanel":"applications","supportPanel":"support","toolsPanel":"tools"};
    Object.keys(panels).forEach(function(id){var el=document.getElementById(id);if(el)el.style.display=(panels[id]===which?"block":"none");});
  }
```

With:

```javascript
  function vaShowPanel(which){
    document.getElementById("mainLayout").style.display=(which==="gps"?"grid":"none");
    const panels={"inboxPanel":"inbox","medicalCentresPanel":"medicalcentres"};
    Object.keys(panels).forEach(function(id){var el=document.getElementById(id);if(el)el.style.display=(panels[id]===which?"block":"none");});
  }
```

Replace `vaHidePanels` at lines 2995-3000:

```javascript
  function vaHidePanels(){
    ["inboxPanel","interviewsPanel","applicationsPanel","supportPanel","toolsPanel"].forEach(function(id){
      var el=document.getElementById(id);if(el)el.style.display="none";
    });
    document.getElementById("mainLayout").style.display="grid";
  }
```

With:

```javascript
  function vaHidePanels(){
    ["inboxPanel","medicalCentresPanel"].forEach(function(id){
      var el=document.getElementById(id);if(el)el.style.display="none";
    });
    document.getElementById("mainLayout").style.display="grid";
  }
```

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat: vault Interviews, Applications, Support, Tools tabs from admin nav"
git push
```

---

### Task 2: Add super-admin gear icon with tools dropdown

Add a gear/cog icon button in the admin header (top-right area) that is only visible to super admin. Clicking it shows a dropdown with the key tool buttons (Gmail setup, Zoho Recruit connect/sync, Zoho Sign, Integrations).

**Files:**
- Modify: `pages/admin.html:624-627` (top-right div — add gear button)
- Modify: `pages/admin.html` (CSS section — add gear dropdown styles)
- Modify: `pages/admin.html` (JS — add gear dropdown render and toggle logic)
- Modify: `pages/admin.html:3773-3778` (init — show gear icon for SA)

- [ ] **Step 1: Add gear button HTML in top-right**

Replace lines 624-628:

```html
    <div class="top-right">
      <span class="top-meta" id="topMeta"></span>
      <button class="btn ghost" id="syncBtn" title="Sync cases">Sync</button>
      <button class="btn ghost" id="logoutBtn">Logout</button>
    </div>
```

With:

```html
    <div class="top-right">
      <span class="top-meta" id="topMeta"></span>
      <div class="sa-tools-wrap" id="saToolsWrap" style="display:none;position:relative">
        <button class="btn ghost" id="saToolsBtn" title="Super Admin Tools">&#9881;</button>
        <div class="sa-tools-dropdown" id="saToolsDropdown" style="display:none">
          <button class="sa-tools-item" data-sa-tool="gmail-watch">Setup Gmail Watch</button>
          <button class="sa-tools-item" data-sa-tool="zoho-recruit-sync">Sync Zoho Recruit</button>
          <button class="sa-tools-item" data-sa-tool="zoho-sign">Zoho Sign Status</button>
          <button class="sa-tools-item" data-sa-tool="ops-queue">Ops Queue</button>
          <button class="sa-tools-item" data-sa-tool="weekly-sweep">Weekly Sweep</button>
        </div>
      </div>
      <button class="btn ghost" id="syncBtn" title="Sync cases">Sync</button>
      <button class="btn ghost" id="logoutBtn">Logout</button>
    </div>
```

- [ ] **Step 2: Add CSS for the gear dropdown**

Add these styles in the `<style>` block (after the existing `.top-right` styles, around line 30):

```css
.sa-tools-wrap{display:inline-block}
.sa-tools-dropdown{position:absolute;top:100%;right:0;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);min-width:200px;z-index:100;padding:4px 0}
.sa-tools-item{display:block;width:100%;text-align:left;padding:8px 14px;border:none;background:none;font-size:13px;font-weight:500;color:var(--text);cursor:pointer}
.sa-tools-item:hover{background:var(--bg-hover,#f3f4f6)}
```

- [ ] **Step 3: Add JS for gear toggle and tool actions**

Add this after the `isSA()` function definition (around line 1158):

```javascript
  function toggleSaTools(){
    const dd=document.getElementById("saToolsDropdown");
    if(dd)dd.style.display=dd.style.display==="none"?"block":"none";
  }
```

Add a click handler in the event delegation section (after the tab click handler setup):

```javascript
    document.getElementById("saToolsBtn").addEventListener("click",e=>{e.stopPropagation();toggleSaTools();});
    document.addEventListener("click",()=>{const dd=document.getElementById("saToolsDropdown");if(dd)dd.style.display="none";});
    document.getElementById("saToolsDropdown").addEventListener("click",async e=>{
      const btn=e.target.closest("[data-sa-tool]");if(!btn)return;
      const tool=btn.getAttribute("data-sa-tool");
      document.getElementById("saToolsDropdown").style.display="none";
      if(tool==="gmail-watch"&&typeof setupGmailWatch==="function")setupGmailWatch();
      else if(tool==="zoho-recruit-sync"){try{await fetch("/api/admin/integrations/zoho-recruit/sync",{method:"POST",credentials:"same-origin"});alert("Zoho Recruit sync started.");}catch{alert("Sync failed.");}}
      else if(tool==="zoho-sign"&&typeof loadZohoSignStatus==="function"){loadZohoSignStatus();alert("Zoho Sign status refreshed. Check console.");}
      else if(tool==="ops-queue"&&typeof loadOpsQueue==="function")loadOpsQueue();
      else if(tool==="weekly-sweep"){try{await fetch("/api/admin/va/sweep",{method:"POST",credentials:"same-origin"});alert("Sweep triggered.");}catch{alert("Sweep failed.");}}
    });
```

- [ ] **Step 4: Show gear icon for super admin on init**

In the init block at line 3773-3778, after the `isSA()` check, add the gear icon display:

```javascript
  loadSession().then(ok=>{
    if(!ok)return;
    if(isSA()){
      const agentTab=document.getElementById("agentTab");
      if(agentTab)agentTab.style.display="";
      const saWrap=document.getElementById("saToolsWrap");
      if(saWrap)saWrap.style.display="";
    }
    loadAll();
    S.refreshTimer=setInterval(()=>{if(document.visibilityState!=="visible")return;loadAll();},15000);
  })
```

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add super-admin gear icon with tools dropdown in admin header"
git push
```

---

### Task 3: Add backend API endpoint for medical centres

Add `GET /api/admin/medical-centres` that queries `career_roles` and groups by practice name to return medical centre cards with their job openings. Benefits are extracted from `source_payload.zoho.Benefit_1/2/3`.

**Files:**
- Modify: `server.js` (add new route near other admin career routes, around line 17060)

- [ ] **Step 1: Add the medical centres list endpoint**

Insert this route **before** the existing `/api/admin/career/applications` route (before line 17060 in `server.js`):

```javascript
  // ── Medical Centres (grouped from career_roles) ──
  if (pathname === '/api/admin/medical-centres' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Supabase database configuration is required.' });
      return;
    }
    if (!requireAdminSession(req, res)) return;
    try {
      const result = await supabaseDbRequest(
        'career_roles',
        'select=id,title,practice_name,location_city,location_state,location_label,billing_model,employment_type,practice_type,summary,is_active,source_payload&is_active=eq.true&order=practice_name.asc'
      );
      const roles = result.ok && Array.isArray(result.data) ? result.data : [];
      const centreMap = {};
      for (const r of roles) {
        const key = (r.practice_name || 'Unknown Practice').trim();
        if (!centreMap[key]) {
          const sp = r.source_payload && typeof r.source_payload === 'object' ? r.source_payload : {};
          const zoho = sp.zoho && typeof sp.zoho === 'object' ? sp.zoho : {};
          centreMap[key] = {
            id: encodeURIComponent(key),
            practice_name: key,
            client_name: String(zoho.Client_Name || zoho.Account_Name || key).replace(/^[\d_]+$/, key),
            location: r.location_label || ((r.location_city || '') + (r.location_state ? ', ' + r.location_state : '')),
            work_type: r.employment_type || '',
            benefit_1: String(zoho.Benefit_1 || zoho.Benefit1 || ''),
            benefit_2: String(zoho.Benefit_2 || zoho.Benefit2 || ''),
            benefit_3: String(zoho.Benefit_3 || zoho.Benefit3 || ''),
            address: ((r.location_city || '') + (r.location_state ? ', ' + r.location_state : '') + (r.location_country ? ', ' + r.location_country : '')).replace(/^,\s*/, ''),
            billing_type: r.billing_model || '',
            open_positions: 0,
            job_openings: []
          };
        }
        centreMap[key].open_positions += 1;
        centreMap[key].job_openings.push({
          id: String(r.id),
          title: r.title || 'General Practitioner',
          status: r.is_active ? 'open' : 'closed',
          description: r.summary || ''
        });
        // Update benefits from latest role if earlier was empty
        if (!centreMap[key].benefit_1) {
          const sp2 = r.source_payload && typeof r.source_payload === 'object' ? r.source_payload : {};
          const z2 = sp2.zoho && typeof sp2.zoho === 'object' ? sp2.zoho : {};
          centreMap[key].benefit_1 = String(z2.Benefit_1 || z2.Benefit1 || '');
          centreMap[key].benefit_2 = String(z2.Benefit_2 || z2.Benefit2 || '');
          centreMap[key].benefit_3 = String(z2.Benefit_3 || z2.Benefit3 || '');
        }
      }
      const centres = Object.values(centreMap).sort((a, b) => b.open_positions - a.open_positions);
      sendJson(res, 200, { ok: true, centres });
    } catch (err) {
      console.error('[admin medical-centres] list error:', err && err.message);
      sendJson(res, 500, { ok: false, message: 'Failed to fetch medical centres.' });
    }
    return;
  }
```

- [ ] **Step 2: Add the medical centre applications endpoint**

Insert this route right after the one above:

```javascript
  if (pathname.startsWith('/api/admin/medical-centres/') && pathname.endsWith('/applications') && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Supabase database configuration is required.' });
      return;
    }
    if (!requireAdminSession(req, res)) return;
    try {
      const centreId = decodeURIComponent(pathname.split('/api/admin/medical-centres/')[1].replace('/applications', ''));
      // Get all career_role IDs for this practice
      const rolesResult = await supabaseDbRequest(
        'career_roles',
        `select=id,title&practice_name=eq.${encodeURIComponent(centreId)}`
      );
      const roleRows = rolesResult.ok && Array.isArray(rolesResult.data) ? rolesResult.data : [];
      if (!roleRows.length) {
        sendJson(res, 200, { ok: true, applications: [] });
        return;
      }
      const roleIds = roleRows.map(r => r.id);
      const roleTitleMap = {};
      for (const r of roleRows) roleTitleMap[String(r.id)] = r.title || 'General Practitioner';

      // Fetch applications for these roles
      const appsResult = await supabaseDbRequest(
        'gp_applications',
        `select=id,user_id,career_role_id,status,applied_at&career_role_id=in.(${roleIds.join(',')})&order=applied_at.desc&limit=200`
      );
      const apps = appsResult.ok && Array.isArray(appsResult.data) ? appsResult.data : [];

      const enriched = [];
      for (const app of apps.slice(0, 100)) {
        let gpName = '';
        let userId = app.user_id || '';
        try {
          const profileResult = await supabaseDbRequest('user_profiles', `select=first_name,last_name,email&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
          if (profileResult.ok && Array.isArray(profileResult.data) && profileResult.data[0]) {
            const p = profileResult.data[0];
            gpName = ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || '';
          }
        } catch {}
        enriched.push({
          application_id: app.id,
          user_id: userId,
          gp_name: gpName,
          job_title: roleTitleMap[String(app.career_role_id)] || 'General Practitioner',
          status: app.status || 'applied',
          applied_at: app.applied_at || ''
        });
      }
      sendJson(res, 200, { ok: true, applications: enriched });
    } catch (err) {
      console.error('[admin medical-centres] applications error:', err && err.message);
      sendJson(res, 500, { ok: false, message: 'Failed to fetch applications.' });
    }
    return;
  }
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add GET /api/admin/medical-centres and /applications endpoints"
git push
```

---

### Task 4: Add Medical Centres frontend — state, data loading, list view

Add the state properties, data loading function, and list-view rendering for the Medical Centres tab.

**Files:**
- Modify: `pages/admin.html` (JS state object ~line 792, new functions after existing data loading)

- [ ] **Step 1: Add state properties for medical centres**

Find the state object `S` around line 792. It starts with `selectedCaseId:null,view:"inbox",...`. Add medical centres state. Find this line:

```javascript
    selectedCaseId:null,view:"inbox",filter:"all",query:"",expanded:{},refreshTimer:null,
```

And add after `refreshTimer:null,`:

```javascript
    mc:{centres:[],loading:false,selectedCentre:null,subView:"overview"},
```

- [ ] **Step 2: Add data loading function**

Add after the existing `loadAll` function (after line 1217):

```javascript
  async function loadMedicalCentres(){
    if(S.mc.loading)return;
    S.mc.loading=true;
    renderMedicalCentresPanel();
    try{
      const r=await fetch("/api/admin/medical-centres",{credentials:"same-origin"});
      const d=await r.json().catch(()=>({}));
      if(d.ok&&Array.isArray(d.centres))S.mc.centres=d.centres;
    }catch{}
    S.mc.loading=false;
    renderMedicalCentresPanel();
  }
  async function loadMedicalCentreApplications(centreId){
    try{
      const r=await fetch("/api/admin/medical-centres/"+encodeURIComponent(centreId)+"/applications",{credentials:"same-origin"});
      const d=await r.json().catch(()=>({}));
      return d.ok&&Array.isArray(d.applications)?d.applications:[];
    }catch{return[];}
  }
```

- [ ] **Step 3: Add the list view renderer**

Add after the functions above:

```javascript
  function renderMedicalCentresPanel(){
    const el=document.getElementById("medicalCentresPanel");if(!el)return;
    if(S.mc.selectedCentre){renderMedicalCentreDetail();return;}
    if(S.mc.loading){el.innerHTML='<div class="empty" style="padding:40px">Loading medical centres\u2026</div>';return;}
    if(!S.mc.centres.length){el.innerHTML='<div class="empty" style="padding:40px">No medical centres with open positions found.</div>';return;}
    let h='<div style="padding:16px"><h2 style="margin:0 0 12px;font-size:18px">Medical Centres</h2><div class="mc-grid">';
    for(const c of S.mc.centres){
      const benefits=[];
      if(c.benefit_1)benefits.push(esc(c.benefit_1));
      if(c.benefit_2)benefits.push(esc(c.benefit_2));
      if(c.benefit_3)benefits.push(esc(c.benefit_3));
      h+=`<div class="mc-card" data-mc-id="${esc(c.id)}">
        <div class="mc-card-header">
          <div class="mc-card-name">${esc(c.practice_name)}</div>
          <span class="task-badge open">${c.open_positions} open</span>
        </div>
        ${c.client_name&&c.client_name!==c.practice_name?`<div class="mc-card-row"><span class="mc-label">Client</span> ${esc(c.client_name)}</div>`:''}
        ${c.location?`<div class="mc-card-row"><span class="mc-label">Location</span> ${esc(c.location)}</div>`:''}
        ${c.address?`<div class="mc-card-row"><span class="mc-label">Address</span> ${esc(c.address)}</div>`:''}
        ${c.work_type?`<div class="mc-card-row"><span class="mc-label">Work Type</span> ${esc(c.work_type)}</div>`:''}
        ${c.billing_type?`<div class="mc-card-row"><span class="mc-label">Billing</span> ${esc(c.billing_type)}</div>`:''}
        ${benefits.length?`<div class="mc-card-row"><span class="mc-label">Benefits</span> ${benefits.join(' &middot; ')}</div>`:''}
      </div>`;
    }
    h+='</div></div>';
    el.innerHTML=h;
  }
```

- [ ] **Step 4: Add CSS for medical centre cards**

Add in the `<style>` block (after the `.task-badge` styles around line 62):

```css
.mc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.mc-card{padding:14px 16px;border-radius:var(--radius,8px);border:1px solid var(--line,#e5e7eb);cursor:pointer;transition:all .12s;background:#fff}
.mc-card:hover{border-color:#bfdbfe;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.mc-card-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.mc-card-name{font-weight:700;font-size:14px;color:var(--text)}
.mc-card-row{font-size:12px;color:var(--muted,#6b7280);margin-top:3px}
.mc-label{font-weight:600;color:var(--text);margin-right:4px}
.mc-detail-header{padding:16px;border-bottom:1px solid var(--line,#e5e7eb)}
.mc-detail-back{border:none;background:none;font-size:13px;font-weight:600;color:var(--blue,#2563eb);cursor:pointer;padding:0;margin-bottom:8px}
.mc-detail-back:hover{text-decoration:underline}
.mc-subnav{display:flex;gap:0;border-bottom:1px solid var(--line,#e5e7eb);padding:0 16px}
.mc-subnav-btn{padding:8px 16px;border:none;background:none;font-size:13px;font-weight:600;color:var(--muted,#6b7280);cursor:pointer;border-bottom:2px solid transparent}
.mc-subnav-btn.active{color:var(--blue,#2563eb);border-bottom-color:var(--blue,#2563eb)}
.mc-subnav-btn:hover{color:var(--text)}
.mc-apps-table{width:100%;border-collapse:collapse;font-size:13px}
.mc-apps-table th{text-align:left;padding:8px 12px;font-weight:600;color:var(--muted,#6b7280);border-bottom:1px solid var(--line,#e5e7eb);font-size:11px;text-transform:uppercase}
.mc-apps-table td{padding:8px 12px;border-bottom:1px solid var(--line,#e5e7eb)}
.mc-apps-table .gp-link{color:var(--blue,#2563eb);text-decoration:none;font-weight:600;cursor:pointer}
.mc-apps-table .gp-link:hover{text-decoration:underline}
.mc-status-pill{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#f3f4f6;color:#374151}
.mc-status-pill.applied{background:#dbeafe;color:#1d4ed8}
.mc-status-pill.interview_scheduled{background:#fef3c7;color:#92400e}
.mc-status-pill.offer,.mc-status-pill.offered{background:#d1fae5;color:#065f46}
.mc-status-pill.placement_secured{background:#c7d2fe;color:#3730a3}
```

- [ ] **Step 5: Add click handler for medical centre cards**

Add this after the existing event delegation (after the tab click handler, around where tools-sub handlers used to be). Place it inside the main IIFE, near the other event listeners:

```javascript
    document.getElementById("medicalCentresPanel").addEventListener("click",async e=>{
      const card=e.target.closest("[data-mc-id]");
      if(card){
        const id=card.getAttribute("data-mc-id");
        S.mc.selectedCentre=S.mc.centres.find(c=>c.id===id)||null;
        S.mc.subView="overview";
        renderMedicalCentresPanel();
        return;
      }
      const back=e.target.closest("[data-mc-back]");
      if(back){
        S.mc.selectedCentre=null;
        renderMedicalCentresPanel();
        return;
      }
      const subBtn=e.target.closest("[data-mc-sub]");
      if(subBtn){
        S.mc.subView=subBtn.getAttribute("data-mc-sub");
        renderMedicalCentreDetail();
        return;
      }
      const gpLink=e.target.closest("[data-mc-gp-id]");
      if(gpLink){
        e.preventDefault();
        const userId=gpLink.getAttribute("data-mc-gp-id");
        window.open("/pages/admin.html?gp="+encodeURIComponent(userId),"_blank");
        return;
      }
    });
```

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Medical Centres list view with card grid in admin"
git push
```

---

### Task 5: Add Medical Centre detail view with Overview and Applications sub-nav

Render the detail view when a centre is selected, with sub-navigation for Overview (job openings) and Applications (table with GP links).

**Files:**
- Modify: `pages/admin.html` (add `renderMedicalCentreDetail` function after `renderMedicalCentresPanel`)

- [ ] **Step 1: Add the detail renderer function**

Add this function right after `renderMedicalCentresPanel`:

```javascript
  async function renderMedicalCentreDetail(){
    const el=document.getElementById("medicalCentresPanel");if(!el)return;
    const c=S.mc.selectedCentre;if(!c){renderMedicalCentresPanel();return;}
    const benefits=[];
    if(c.benefit_1)benefits.push(esc(c.benefit_1));
    if(c.benefit_2)benefits.push(esc(c.benefit_2));
    if(c.benefit_3)benefits.push(esc(c.benefit_3));
    let h=`<div class="mc-detail-header">
      <button class="mc-detail-back" data-mc-back>&larr; Back to Medical Centres</button>
      <h2 style="margin:0 0 8px;font-size:18px">${esc(c.practice_name)}</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:13px;max-width:600px">
        ${c.client_name&&c.client_name!==c.practice_name?`<div><span class="mc-label">Client</span> ${esc(c.client_name)}</div>`:''}
        ${c.location?`<div><span class="mc-label">Location</span> ${esc(c.location)}</div>`:''}
        ${c.address?`<div><span class="mc-label">Address</span> ${esc(c.address)}</div>`:''}
        ${c.work_type?`<div><span class="mc-label">Work Type</span> ${esc(c.work_type)}</div>`:''}
        ${c.billing_type?`<div><span class="mc-label">Billing</span> ${esc(c.billing_type)}</div>`:''}
        ${benefits.length?`<div style="grid-column:1/-1"><span class="mc-label">Benefits</span> ${benefits.join(' &middot; ')}</div>`:''}
        <div><span class="mc-label">Open Positions</span> ${c.open_positions}</div>
      </div>
    </div>`;
    h+=`<div class="mc-subnav">
      <button class="mc-subnav-btn ${S.mc.subView==="overview"?"active":""}" data-mc-sub="overview">Overview</button>
      <button class="mc-subnav-btn ${S.mc.subView==="applications"?"active":""}" data-mc-sub="applications">Applications</button>
    </div>`;
    if(S.mc.subView==="overview"){
      h+='<div style="padding:16px">';
      if(!c.job_openings||!c.job_openings.length){
        h+='<div class="empty">No job openings found.</div>';
      }else{
        for(const j of c.job_openings){
          h+=`<div style="padding:10px 0;border-bottom:1px solid var(--line,#e5e7eb)">
            <div style="font-weight:600;font-size:14px">${esc(j.title)}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">Status: <span class="mc-status-pill">${esc(j.status)}</span></div>
            ${j.description?`<div style="font-size:13px;color:var(--text);margin-top:6px;line-height:1.5">${esc(j.description).substring(0,300)}${j.description.length>300?'…':''}</div>`:''}
          </div>`;
        }
      }
      h+='</div>';
    }else if(S.mc.subView==="applications"){
      h+='<div style="padding:16px"><div class="empty">Loading applications\u2026</div></div>';
      el.innerHTML=h;
      const apps=await loadMedicalCentreApplications(c.id);
      let appsHtml='<div style="padding:16px">';
      if(!apps.length){
        appsHtml+='<div class="empty">No applications for this medical centre yet.</div>';
      }else{
        appsHtml+=`<table class="mc-apps-table"><thead><tr><th>GP Name</th><th>Job Opening</th><th>Status</th><th>Date Applied</th></tr></thead><tbody>`;
        for(const a of apps){
          const dateStr=a.applied_at?new Date(a.applied_at).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'}):'—';
          const statusClass=esc((a.status||'').replace(/\s+/g,'_'));
          appsHtml+=`<tr>
            <td><a class="gp-link" data-mc-gp-id="${esc(a.user_id)}">${esc(a.gp_name||'Unknown')}</a></td>
            <td>${esc(a.job_title)}</td>
            <td><span class="mc-status-pill ${statusClass}">${esc((a.status||'applied').replace(/_/g,' '))}</span></td>
            <td>${dateStr}</td>
          </tr>`;
        }
        appsHtml+='</tbody></table>';
      }
      appsHtml+='</div>';
      // Re-render with loaded data — rebuild the header+subnav+content
      const wrapper=el.querySelector('[style*="Loading applications"]');
      if(wrapper&&wrapper.parentElement){wrapper.parentElement.innerHTML=appsHtml.replace(/^<div style="padding:16px">/,'').replace(/<\/div>$/,'');}
      else{
        // Fallback: full re-render
        const subContent=el.querySelector('.mc-subnav');
        if(subContent&&subContent.nextElementSibling)subContent.nextElementSibling.outerHTML=appsHtml;
      }
      return;
    }
    el.innerHTML=h;
  }
```

- [ ] **Step 2: Add URL param handling for GP deep-link**

The GP name links open `/pages/admin.html?gp=<user_id>` in a new tab. Add URL param handling in the init block. Find line 3773:

```javascript
  loadSession().then(ok=>{
    if(!ok)return;
```

After `if(!ok)return;` add:

```javascript
    const urlParams=new URLSearchParams(window.location.search);
    const gpParam=urlParams.get("gp");
    if(gpParam){S.selectedCaseId=gpParam;S.view="gps";document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t.getAttribute("data-view")==="gps"));vaShowPanel("gps");}
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Medical Centre detail view with overview and applications sub-nav"
git push
```

---

### Task 6: Clean up removed function references and verify

Remove references to vaulted functions that would cause errors, and verify the app loads correctly.

**Files:**
- Modify: `pages/admin.html` (window.* exports for removed functions, any stale references)

- [ ] **Step 1: Check for stale references to vaulted views**

Search for references to `loadInterviews`, `loadAdminApplications`, `loadSupportItems`, `renderSupportPanel`, `renderToolsPanel` in event handlers or init code outside of their own function definitions. These functions can remain defined (they're dead code but harmless) — just ensure nothing actively calls them. The tab click handler was already updated in Task 1 to remove the calls.

Verify the `loadAll` function (line 1206) does NOT call any of these — it calls `loadDash`, `loadCases`, `loadTasks`, `loadVisa`, `loadPbs`, `loadVaDashboard`, `loadUnmatchedDocuments`, `loadIncomingQuestions`. None of the vaulted functions are called on load. Good.

- [ ] **Step 2: Check for event delegation that references vaulted tools**

Search for `data-tools-sub` handler references. The tools sub-nav click handler at line ~3700 should still work but will never fire since the toolsPanel HTML is removed. This is harmless dead code. No action needed.

- [ ] **Step 3: Start the dev server and verify**

```bash
npm start
```

Open `http://localhost:3000/pages/admin.html` in the browser. Verify:
1. Only Inbox, GPs, and Medical Centres tabs appear
2. Clicking Medical Centres loads the centre cards (or shows empty state if no data)
3. Gear icon appears only for super admin sessions
4. GPs tab still works normally
5. No console errors

- [ ] **Step 4: Test medical centre detail + applications**

If medical centres loaded with data:
1. Click a centre card — should show detail view with back button, info grid, sub-nav
2. Click "Overview" tab — shows job openings
3. Click "Applications" tab — shows applications table (or empty state)
4. Click GP name link — opens admin page in new tab with GP selected
5. Click back button — returns to centres list

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add pages/admin.html server.js
git commit -m "fix: clean up stale references from vaulted admin tabs"
git push
```
