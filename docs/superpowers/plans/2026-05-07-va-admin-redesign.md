# VA Admin Page Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the VA Command Centre GPs tab with stage-grouped tasks, guided next-actions, priority lanes, journey rail, and consolidated navigation — to reduce VA training time.

**Architecture:** Frontend-only changes to `pages/admin.html`. Replace priority-based task rendering with stage-grouped rendering. Replace flat GP list with Needs Action / On Track priority lanes. Add compact profile bar with expand toggle, horizontal journey rail, and ••• dropdown menus. Consolidate from 5 top tabs to 4 (rename Tools to Ops Queue, absorb Inbox into GPs). No API or database changes.

**Tech Stack:** Vanilla JS/HTML/CSS (inline in admin.html), existing Supabase API endpoints unchanged.

---

### Task 1: Add New CSS for Redesigned Components

**Files:**
- Modify: `pages/admin.html:10-200` (CSS section)

This task adds all new CSS classes needed by subsequent tasks. No existing styles are removed yet — that happens during cleanup in the final task.

- [ ] **Step 1: Add priority lane styles**

Add after line ~130 (after `.tl-item` styles), before the closing `</style>`:

```css
/* ── Priority Lanes ── */
.lane-label{display:flex;align-items:center;gap:6px;padding:6px 14px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em}
.lane-label .lane-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.lane-label.needs-action .lane-dot{background:var(--red)}
.lane-label.needs-action{color:var(--red)}
.lane-label.on-track .lane-dot{background:var(--green)}
.lane-label.on-track{color:var(--green)}
.lane-divider{border-top:1px solid var(--line);margin:4px 14px}
```

- [ ] **Step 2: Add profile bar styles**

```css
/* ── Profile Bar ── */
.profile-bar{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--panel);border-radius:var(--radius);border:1px solid var(--line);margin-bottom:8px}
.profile-bar .pb-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--purple-1));display:grid;place-items:center;color:#fff;font-size:13px;font-weight:800;flex-shrink:0}
.profile-bar .pb-info{flex:1;min-width:0}
.profile-bar .pb-name{font-size:14px;font-weight:800;letter-spacing:-.01em}
.profile-bar .pb-meta{font-size:11px;color:var(--muted);font-weight:500;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.profile-bar .pb-pills{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.profile-bar .pb-pill{padding:3px 8px;border-radius:6px;font-size:10px;font-weight:800}
.pb-expand-toggle{background:none;border:none;cursor:pointer;font-size:14px;color:var(--muted);padding:4px}
.pb-expand-panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px;margin-bottom:8px;display:none}
.pb-expand-panel.open{display:block}
```

- [ ] **Step 3: Add journey rail styles**

```css
/* ── Journey Rail ── */
.journey-rail{display:flex;align-items:center;gap:0;padding:8px 16px;background:var(--bg2);border-radius:var(--radius);border:1px solid var(--line);margin-bottom:8px;overflow-x:auto;flex-wrap:nowrap}
.jr-step{display:flex;align-items:center;gap:0;flex-shrink:0}
.jr-pill{padding:4px 10px;font-size:10px;font-weight:700;white-space:nowrap}
.jr-pill.done{background:var(--green);color:#fff;border-radius:3px 0 0 3px}
.jr-pill.current{background:var(--blue);color:#fff;font-weight:800;box-shadow:0 0 8px rgba(37,99,235,.3)}
.jr-pill.pending{background:var(--bg3);color:var(--muted);border-radius:0 3px 3px 0}
.jr-pill:first-child{border-radius:3px 0 0 3px}
.jr-pill:last-child{border-radius:0 3px 3px 0}
.jr-arrow{width:0;height:0;border-top:12px solid transparent;border-bottom:12px solid transparent;margin-right:-1px;flex-shrink:0}
.jr-arrow.done{border-left:8px solid var(--green)}
.jr-arrow.current{border-left:8px solid var(--blue)}
.jr-arrow.pending{border-left:8px solid var(--bg3)}
```

- [ ] **Step 4: Add stage-grouped task styles**

```css
/* ── Stage Groups ── */
.stage-group{margin-bottom:16px}
.stage-group-header{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.sg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sg-dot.active{background:var(--blue)}
.sg-dot.locked{background:var(--bg3)}
.sg-label{font-size:13px;font-weight:700}
.sg-label.active{color:var(--text)}
.sg-label.locked{color:var(--muted)}
.sg-count{font-size:11px;color:var(--muted);font-weight:500}
.sg-lock-badge{font-size:10px;color:var(--muted);background:var(--bg2);padding:2px 8px;border-radius:4px;margin-left:auto}
.stage-group.locked .stage-task{opacity:.35;pointer-events:none}

/* ── Guided Task Card ── */
.stage-task{background:var(--panel);border-radius:var(--radius);border:1px solid var(--line);padding:12px;margin-bottom:6px;transition:border-color .15s}
.stage-task:hover{border-color:#cbd5e1}
.stage-task.active-next{border-left:3px solid var(--blue)}
.stage-task .st-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.stage-task .st-body{flex:1;min-width:0}
.stage-task .st-title{font-size:13px;font-weight:700}
.stage-task .st-title .urgent-badge{background:#fef2f2;color:var(--red);font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;margin-left:6px}
.stage-task .st-title .overdue-badge{background:#fffbeb;color:var(--amber);font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;margin-left:6px}
.stage-task .st-guide{font-size:11px;color:var(--blue);margin-top:4px;background:#eff6ff;display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600}
.stage-task .st-doc-info{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px}
.stage-task .st-doc-chip{background:var(--bg2);border-radius:4px;padding:2px 8px;color:var(--muted);font-weight:500}
.stage-task .st-actions{display:flex;gap:4px;flex-shrink:0;margin-left:8px}
.stage-task .st-primary-btn{padding:5px 14px;border-radius:8px;font-size:11px;font-weight:700;background:var(--blue);color:#fff;border:none;cursor:pointer;font-family:inherit}
.stage-task .st-primary-btn:hover{background:#1d4ed8}
.stage-task .st-more-btn{padding:5px 8px;border-radius:8px;font-size:12px;font-weight:700;background:var(--bg3);color:var(--muted);border:none;cursor:pointer;font-family:inherit;position:relative}
.stage-task .st-more-btn:hover{background:#cbd5e1}
.stage-task .st-waiting{font-size:11px;color:var(--amber);margin-top:4px;font-weight:600}
```

- [ ] **Step 5: Add dropdown menu styles**

```css
/* ── Dropdown Menu ── */
.st-dropdown{position:absolute;right:0;top:calc(100% + 4px);background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);min-width:200px;z-index:50;padding:4px 0;display:none}
.st-dropdown.open{display:block}
.st-dropdown-item{display:block;width:100%;text-align:left;padding:7px 12px;border:none;background:none;font-size:12px;font-weight:500;color:var(--text);cursor:pointer;font-family:inherit}
.st-dropdown-item:hover{background:var(--bg2)}
.st-dropdown-sep{border-top:1px solid var(--line);margin:3px 0}
```

- [ ] **Step 6: Add GP sub-tab restyling**

```css
/* ── GP Sub-Tabs (Tasks | Notes) ── */
.gp-subtabs{display:flex;gap:0;border-bottom:1px solid var(--line);margin-bottom:12px}
.gp-subtab{padding:8px 16px;font-size:12px;font-weight:700;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
.gp-subtab.active{color:var(--blue);border-bottom-color:var(--blue)}
.gp-subtab:hover{color:var(--text)}
.gp-subtab .subtab-count{background:var(--bg3);padding:1px 6px;border-radius:10px;font-size:10px;margin-left:4px}
.gp-subtab.active .subtab-count{background:var(--blue);color:#fff}
```

- [ ] **Step 7: Commit CSS changes**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): add CSS for redesigned VA command centre components"
```

---

### Task 2: Consolidate Top Navigation to 4 Tabs

**Files:**
- Modify: `pages/admin.html:680-685` (tab HTML)
- Modify: `pages/admin.html:2805` (tab click handler)
- Modify: `pages/admin.html:3357` (`vaShowPanel()`)
- Modify: `pages/admin.html:864` (S.view default)

- [ ] **Step 1: Change default view from inbox to gps**

Change line 864, in the `S` state object:

```javascript
// OLD:
view:"inbox",

// NEW:
view:"gps",
```

- [ ] **Step 2: Update the view-tabs HTML**

Replace lines 680-685:

```html
<!-- OLD: -->
<div class="view-tabs">
  <div class="view-tab active" data-view="inbox">Inbox</div>
  <div class="view-tab" data-view="gps">GPs</div>
  <div class="view-tab" data-view="medicalcentres">Medical Centres</div>
  <div class="view-tab" data-view="support">Support</div>
  <div class="view-tab" data-view="tools">Tools</div>
</div>

<!-- NEW: -->
<div class="view-tabs">
  <div class="view-tab active" data-view="gps">GPs</div>
  <div class="view-tab" data-view="medicalcentres">Medical Centres</div>
  <div class="view-tab" data-view="support">Support</div>
  <div class="view-tab" data-view="tools">Ops Queue</div>
</div>
```

- [ ] **Step 3: Update `vaShowPanel()` to remove inbox handling**

In `vaShowPanel()` (line ~3357), remove the inbox panel toggle. The function currently toggles visibility of `inboxPanel`, `mainLayout`, `medicalCentresPanel`, `supportPanel`, `toolsPanel`. Remove the inboxPanel case — when `which === "gps"`, show `mainLayout` and hide the rest (this is already the behavior, just remove the inbox branch).

- [ ] **Step 4: Update tab click handler to load GPs on first visit**

In the tab click handler (line ~2805), for the `gps` view case, add the VA dashboard load that was previously done by the inbox tab:

```javascript
// In the click handler for data-view tabs:
if (view === "gps") {
  if (!S.va.dashboard) await loadVaDashboard();
  renderCaseList();
  renderDetail();
}
```

- [ ] **Step 5: Update initial page load to default to GPs view**

Find the initial `loadAll()` call and ensure it renders the GPs view with priority lanes on page load:

```javascript
// After loadAll() completes, in the initialization block:
vaShowPanel("gps");
renderCaseList();
renderDetail();
```

- [ ] **Step 6: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): consolidate top nav to 4 tabs — GPs, Medical Centres, Support, Ops Queue"
```

---

### Task 3: Implement Priority Lanes in GP List

**Files:**
- Modify: `pages/admin.html:1636-1672` (`renderCaseList()`)
- Modify: `pages/admin.html:1573-1594` (`filteredCases()`)
- Modify: `pages/admin.html:1623-1634` (`renderFilters()`)

- [ ] **Step 1: Replace `renderCaseList()` with priority lane version**

Replace the existing `renderCaseList()` function (lines 1636-1672) with:

```javascript
function renderCaseList(){
  const el=document.getElementById("caseList");
  if(S.view==="queue"){renderQueueList();return;}
  if(S.view==="agent"){renderAgentRunList();return;}

  const list=filteredCases();
  if(!list.length){el.innerHTML='<div class="empty">'+(S.cases.length||S.dashboard?"No cases match filter.":"Loading...")+'</div>';return;}

  /* Split into priority lanes */
  const needsAction=[];
  const onTrack=[];
  list.forEach(m=>{
    const rc=m.rc;
    if(!rc){onTrack.push(m);return;}
    const hasUrgent=rc.urgent_tasks>0;
    const hasOverdue=rc.overdue_tasks>0;
    const hasDueToday=(S.tasks||[]).some(t=>t.case_id===rc.id&&t.due_date&&isSameDay(new Date(t.due_date),new Date())&&t.status!=='completed');
    if(hasUrgent||hasOverdue||hasDueToday){needsAction.push(m);}
    else{onTrack.push(m);}
  });

  let html='';
  if(needsAction.length){
    html+='<div class="lane-label needs-action"><span class="lane-dot"></span>Needs Action <span style="margin-left:auto;font-size:11px;opacity:.7">'+needsAction.length+'</span></div>';
    html+=needsAction.map(m=>renderCaseCard(m,true)).join("");
  }
  if(needsAction.length&&onTrack.length){
    html+='<div class="lane-divider"></div>';
  }
  if(onTrack.length){
    html+='<div class="lane-label on-track"><span class="lane-dot"></span>On Track <span style="margin-left:auto;font-size:11px;opacity:.7">'+onTrack.length+'</span></div>';
    html+=onTrack.map(m=>renderCaseCard(m,false)).join("");
  }
  el.innerHTML=html;
}

function isSameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}
```

- [ ] **Step 2: Extract `renderCaseCard()` helper**

Add this function — extracted from the old `renderCaseList` inline template, with added urgency indicator:

```javascript
function renderCaseCard(m,showUrgencyDetail){
  const rc=m.rc;const gp=m.gp;
  const id=rc?rc.id:(gp?gp.userId||gp.email:"");
  const sel=S.selectedCaseId===id;
  const name=rc?rc.gp_name:gp?gp.name||gp.email:"Unknown";
  const stage=rc?rc.stage:"";
  const openT=rc?rc.open_tasks||0:0;
  const urgentT=rc?rc.urgent_tasks||0:0;
  const overdueT=rc?rc.overdue_tasks||0:0;
  const hasDueToday=(S.tasks||[]).some(t=>t.case_id===(rc?rc.id:"")&&t.due_date&&isSameDay(new Date(t.due_date),new Date())&&t.status!=='completed');

  let urgencyHtml='';
  if(showUrgencyDetail){
    if(urgentT)urgencyHtml+='<span class="task-badge urgent">'+urgentT+' urgent</span>';
    if(overdueT)urgencyHtml+='<span class="task-badge overdue">overdue</span>';
    if(hasDueToday&&!urgentT&&!overdueT)urgencyHtml+='<span class="task-badge open">due today</span>';
  }

  return '<div class="case-card '+(sel?"selected":"")+'" data-case-id="'+esc(id)+'" data-user-id="'+esc(rc?rc.user_id:gp?gp.userId:"")+'" data-rc-id="'+esc(rc?rc.id:"")+'">'+
    '<div class="case-card-top">'+
      '<div class="case-avatar">'+esc(ini(name))+'</div>'+
      '<div class="case-card-info">'+
        '<div class="case-card-name">'+esc(name)+'</div>'+
        '<div class="case-card-sub">'+(stage?'<span class="case-stage-pill stage-'+esc(stage)+'">'+esc(stage)+'</span>':'')+' '+esc(String(openT))+' task'+(openT===1?'':'s')+'</div>'+
      '</div>'+
    '</div>'+
    (urgencyHtml?'<div class="case-card-tasks">'+urgencyHtml+'</div>':'')+
  '</div>';
}
```

- [ ] **Step 3: Update `renderFilters()` to keep existing filter chips**

Keep the existing filter bar — it still works with priority lanes. The filters control which GPs appear, then the lane split applies. No changes needed to `renderFilters()`.

- [ ] **Step 4: Test visually**

Run the dev server: `npm start`
Open `http://localhost:3000/pages/admin.html` in a browser.
Verify:
- GP list shows "Needs Action" lane with red dot header
- GP list shows "On Track" lane with green dot header
- GPs with urgent/overdue/due-today tasks appear in Needs Action
- Remaining GPs appear in On Track
- Clicking a GP still selects it and shows the detail panel
- Filter chips still work (e.g. "Urgent" filter)

- [ ] **Step 5: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): implement priority lanes — Needs Action vs On Track GP list"
```

---

### Task 4: Implement Compact Profile Bar with Expand Toggle

**Files:**
- Modify: `pages/admin.html:1853-1914` (`renderDetail()` — the GPs branch)

- [ ] **Step 1: Replace the GP detail meta section with compact profile bar**

In `renderDetail()` (line 1853), replace the `metaHtml` variable (lines 1868-1898) with the compact profile bar:

```javascript
const gpName=u.gp_name||c.gp_name||c.gp_email||"";
const gpEmail=u.gp_email||c.gp_email||"";
const gpPhone=u.gp_phone||"";
const gpCountry=u.country||"";
const dtUrl=u.doubletick_conversation_url||u.whatsapp_link||"";
const hasDt=dtUrl.indexOf("doubletick.io/conversations/")>-1;

const profileBarHtml=`
  <div class="profile-bar">
    <div class="pb-avatar">${esc(ini(gpName))}</div>
    <div class="pb-info">
      <div class="pb-name">${esc(gpName)}</div>
      <div class="pb-meta">${esc(gpEmail)}${gpPhone?' \u2022 '+esc(gpPhone):''}${gpCountry?' \u2022 '+esc(gpCountry):''}</div>
    </div>
    <div class="pb-pills">
      <span class="pb-pill case-stage-pill stage-${esc(c.stage||'')}">${esc(c.stage||'')}</span>
      <span class="pb-pill" style="background:var(--bg2);color:var(--muted)">${u.quals_approved||0}/${u.quals_required||0} docs</span>
      ${hasDt?'<a class="btn sm dt" href="'+safeUrl(dtUrl)+'" target="_blank" rel="noopener" style="font-size:10px;padding:3px 8px">WhatsApp</a>':''}
      <button class="btn sm nudge" data-case-nudge="${esc(c.user_id||u.userId||"")}" data-nudge-stage="${esc(c.stage||"")}" data-nudge-substage="${esc(c.substage||"")}" data-nudge-name="${esc(((gpName).split(" ")[0]||"").trim())}" style="font-size:10px;padding:3px 8px">Nudge</button>
    </div>
    <button class="pb-expand-toggle" data-pb-toggle title="Case management">\u25BE</button>
  </div>
  <div class="pb-expand-panel" id="pbExpandPanel">
    ${renderCaseManagementForm(c)}
  </div>
`;
```

- [ ] **Step 2: Add expand toggle click handler**

In the main event delegation block (around line 2773), add:

```javascript
// Profile bar expand toggle
if(e.target.closest("[data-pb-toggle]")){
  const panel=document.getElementById("pbExpandPanel");
  if(panel){
    panel.classList.toggle("open");
    const btn=e.target.closest("[data-pb-toggle]");
    btn.textContent=panel.classList.contains("open")?"\u25B4":"\u25BE";
  }
}
```

- [ ] **Step 3: Update `renderDetail()` layout to use new structure**

Replace the `el.innerHTML=...` line (1913) with the new layout that uses profile bar instead of the 2-column `gp-detail-grid`:

```javascript
const tab=S.gpsProfileTab||"tasks";
const tabsBar=`<div class="gp-subtabs">
  <div class="gp-subtab ${tab==="tasks"?"active":""}" data-gp-tab="tasks">Tasks <span class="subtab-count">${(S.tasks||[]).filter(t=>t.case_id===c.id&&t.status!=="completed").length}</span></div>
  <div class="gp-subtab ${tab==="notes"?"active":""}" data-gp-tab="notes">Notes</div>
</div>`;
const paneHtml=tab==="tasks"?renderGpTasksPane(c):renderGpNotesPane(c);
el.innerHTML=`
  <button class="btn sm" data-gp-back style="margin-bottom:8px;display:none">\u2190 Back</button>
  ${profileBarHtml}
  ${renderJourneyRail(c)}
  ${tabsBar}
  <div class="gp-detail-tab-pane">${paneHtml}</div>
`;
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): compact profile bar with expand toggle for case management"
```

---

### Task 5: Implement Journey Rail

**Files:**
- Modify: `pages/admin.html` — add `renderJourneyRail()` function near the other GP rendering functions (~line 1768)

- [ ] **Step 1: Add `renderJourneyRail()` function**

Add this function after `renderGpJourneyPane()`:

```javascript
function renderJourneyRail(c){
  const gp=findGp(c);
  if(typeof buildJourney!=="function")return '';
  const journey=gp?buildJourney(gp):[];
  if(!journey.length)return '';

  /* Filter out visa step (deferred) */
  const steps=journey.filter(s=>s.key!=="visa");

  let html='<div class="journey-rail">';
  steps.forEach((step,idx)=>{
    const cls=step.status==="done"?"done":step.status==="current"?"current":"pending";
    const label=step.status==="done"?"\u2713 "+step.label:step.status==="current"?"\u25CF "+step.label:step.label;
    html+='<div class="jr-step">';
    html+='<div class="jr-pill '+cls+'">'+esc(label)+'</div>';
    if(idx<steps.length-1){
      html+='<div class="jr-arrow '+cls+'"></div>';
    }
    html+='</div>';
  });
  html+='</div>';
  return html;
}
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): add horizontal journey rail showing stage progression"
```

---

### Task 6: Implement Stage-Grouped Tasks with Guided Actions

**Files:**
- Modify: `pages/admin.html:1710-1737` (`renderGpTasksPane()`)
- Add: `getGuidedAction()` function
- Add: `groupTasksByStage()` function

This is the core of the redesign — replacing priority-based grouping with stage-based grouping, and adding the guided next-action prompt to each task card.

- [ ] **Step 1: Add the `STAGE_ORDER` constant and `groupTasksByStage()` function**

Add near the existing `STEPS` constant (line ~877):

```javascript
const STAGE_ORDER=["career","myintealth","amc","ahpra","pbs","commencement"];

function groupTasksByStage(tasks){
  const groups=new Map();
  const other=[];
  tasks.forEach(t=>{
    const stage=t.related_stage||"";
    if(stage&&STAGE_ORDER.includes(stage)){
      if(!groups.has(stage))groups.set(stage,[]);
      groups.get(stage).push(t);
    }else{
      other.push(t);
    }
  });
  /* Return in STAGE_ORDER, then "other" at end */
  const result=[];
  STAGE_ORDER.forEach(s=>{
    if(groups.has(s))result.push({stage:s,tasks:groups.get(s)});
  });
  if(other.length)result.push({stage:"other",tasks:other});
  return result;
}
```

- [ ] **Step 2: Add the `getGuidedAction()` function**

This function returns `{prompt, buttonLabel, buttonAction}` based on task state:

```javascript
function getGuidedAction(t){
  const dk=t.related_document_key;
  const hasAttachment=!!(t.attachment_url||t.zoho_attachment_id);
  const hasHtml=!!t.document_html;

  /* Practice pack / document tasks */
  if(t.task_type==='practice_pack_child'||dk){
    if(dk==='sppa_00'){
      if(t.zoho_sign_envelope_id)return{prompt:'Check Zoho Sign status for signatures',label:'Check Status',action:'checkSppaStatus',taskId:t.id};
      return{prompt:'Send SPPA agreement via Zoho Sign',label:'Send SPPA',action:'sendSppa',taskId:t.id};
    }
    if(dk==='section_g'){
      if(t.status==='completed')return{prompt:'Section G auto-delivered',label:'Done',action:null,taskId:t.id};
      return{prompt:'Will auto-deliver when GP enters AHPRA stage',label:'Waiting',action:null,taskId:t.id};
    }
    if(dk==='position_description'){
      if(hasHtml)return{prompt:'Review the generated position description and approve',label:'Edit & Review',action:'editPD',taskId:t.id};
      return{prompt:'Generate a position description using AI',label:'Generate',action:'generatePD',taskId:t.id};
    }
    /* offer_contract + supervisor_cv */
    if(hasAttachment&&t.gmail_message_id){
      return{prompt:'Review the auto-matched document and approve or request revision',label:'Review Doc',action:'previewDoc',taskId:t.id};
    }
    if(hasAttachment){
      return{prompt:'Review the uploaded document and approve',label:'Review Doc',action:'previewDoc',taskId:t.id};
    }
    if(t.status==='waiting_on_practice'){
      return{prompt:'Waiting on practice to send the document',label:'Waiting',action:null,taskId:t.id};
    }
    const docLabel=dk==='offer_contract'?'Contract':'Supervisor CV';
    return{prompt:'Email the practice requesting the '+docLabel,label:'Email Practice',action:'emailPractice',taskId:t.id,dk:dk};
  }

  /* Verification tasks */
  if(t.task_type==='verify'){
    return{prompt:'Review the evidence and verify',label:'Review',action:'completeTask',taskId:t.id};
  }

  /* Kickoff / review tasks */
  if(t.task_type==='kickoff'||t.task_type==='review'){
    return{prompt:'Review and complete this task',label:'Complete',action:'completeTask',taskId:t.id};
  }

  /* Blocker / escalation */
  if(t.task_type==='blocker'||t.task_type==='escalation'){
    return{prompt:'Resolve the blocking issue',label:'Resolve',action:'completeTask',taskId:t.id};
  }

  /* WhatsApp help */
  if(t.task_type==='whatsapp_help'){
    return{prompt:'Respond to the GP\u2019s WhatsApp query',label:'Open Chat',action:'openWhatsApp',taskId:t.id};
  }

  /* Follow-up / chase / nudge_reply */
  if(t.task_type==='followup'||t.task_type==='chase'||t.task_type==='nudge_reply'){
    return{prompt:'Follow up with the GP',label:'Follow Up',action:'completeTask',taskId:t.id};
  }

  /* Default */
  return{prompt:'Complete this task',label:'Complete',action:'completeTask',taskId:t.id};
}
```

- [ ] **Step 3: Replace `renderGpTasksPane()` with stage-grouped version**

Replace the entire function (lines 1710-1737):

```javascript
function renderGpTasksPane(c){
  const tasks=(S.tasks||[]).filter(t=>t.case_id===c.id&&t.status!=="complete"&&t.status!=="completed"&&t.status!=="cancelled");
  if(!tasks.length)return '<div class="empty">No open tasks.</div><button class="btn sm" data-add-task>+ Add Task</button>';

  const u=(S.va.dashboard&&Array.isArray(S.va.dashboard.users))
    ?(S.va.dashboard.users.find(x=>x.case_id===c.id||x.user_id===c.user_id)||{}):{};
  const currentStage=c.stage||"";
  const stageGroups=groupTasksByStage(tasks);

  let html='';
  let isFirstActiveTask=true;

  stageGroups.forEach(group=>{
    const stageLabel=STEPS.find(s=>s.key===group.stage);
    const label=stageLabel?stageLabel.label:group.stage==="other"?"Other":"Unknown";
    const stageIdx=STAGE_ORDER.indexOf(group.stage);
    const currentIdx=STAGE_ORDER.indexOf(currentStage);
    const isCurrentOrPast=group.stage==="other"||stageIdx<=currentIdx||currentIdx===-1;
    const isLocked=!isCurrentOrPast&&stageIdx>currentIdx&&currentIdx!==-1;

    html+='<div class="stage-group'+(isLocked?' locked':'')+'">';
    html+='<div class="stage-group-header">';
    html+='<div class="sg-dot '+(isLocked?'locked':'active')+'"></div>';
    html+='<div class="sg-label '+(isLocked?'locked':'active')+'">'+esc(label)+'</div>';
    html+='<div class="sg-count">'+group.tasks.length+' task'+(group.tasks.length===1?'':'s')+'</div>';

    if(isLocked){
      const unlockStage=STEPS.find(s=>s.key===currentStage);
      html+='<div class="sg-lock-badge">\uD83D\uDD12 Unlocks after '+(unlockStage?unlockStage.label:currentStage)+'</div>';
    }
    if(!isLocked&&group.stage===currentStage){
      html+='<div class="sg-lock-badge" style="background:#eff6ff;color:var(--blue)">Current stage</div>';
    }
    html+='</div>';

    if(isLocked){
      /* Show collapsed summary for locked stages */
      html+='<div class="stage-task" style="opacity:.35;pointer-events:none"><div class="st-body"><div style="font-size:11px;color:var(--muted)">'+group.tasks.map(t=>esc(t.title)).join(' \u2022 ')+'</div></div></div>';
    }else{
      group.tasks.forEach(t=>{
        const guided=getGuidedAction(t);
        const isUrgent=t.priority==='urgent';
        const isOverdue=t.is_overdue||(t.due_date&&new Date(t.due_date)<new Date());
        const isNext=isFirstActiveTask;
        if(isNext)isFirstActiveTask=false;

        html+='<div class="stage-task'+(isNext?' active-next':'')+'" data-task-row="'+esc(t.id)+'">';
        html+='<div class="st-top">';
        html+='<div class="st-body">';
        html+='<div class="st-title">'+esc(t.title);
        if(isUrgent)html+='<span class="urgent-badge">urgent</span>';
        if(isOverdue)html+='<span class="overdue-badge">overdue</span>';
        html+='</div>';

        /* Document info inline */
        if(t.attachment_url&&t.attachment_filename){
          const conf=typeof t.ai_confidence==='number'?Math.round(t.ai_confidence*100):0;
          html+='<div class="st-doc-info">';
          html+='<span class="st-doc-chip">\uD83D\uDCC4 '+esc(t.attachment_filename)+'</span>';
          if(t.gmail_message_id)html+='<span style="font-size:10px;color:var(--muted)">Auto-matched \u2022 '+conf+'% confidence</span>';
          html+='</div>';
        }

        /* Guided prompt */
        if(guided.prompt&&guided.action!==null){
          html+='<div class="st-guide">\u2192 '+esc(guided.prompt)+'</div>';
        }
        if(t.status==='waiting_on_practice'){
          html+='<div class="st-waiting">\u23F3 Waiting on practice</div>';
        }else if(t.status==='waiting_on_gp'){
          html+='<div class="st-waiting">\u23F3 Waiting on GP</div>';
        }else if(t.status==='waiting_on_external'){
          html+='<div class="st-waiting">\u23F3 Waiting on external</div>';
        }

        html+='</div>'; /* close st-body */
        html+='<div class="st-actions">';
        if(guided.action){
          html+='<button class="st-primary-btn" data-guided-action="'+esc(guided.action)+'" data-task-id="'+esc(t.id)+'"'+(guided.dk?' data-doc-key="'+esc(guided.dk)+'"':'')+'>'+esc(guided.label)+'</button>';
        }
        html+='<button class="st-more-btn" data-more-menu="'+esc(t.id)+'">\u2022\u2022\u2022';
        html+='<div class="st-dropdown" id="dropdown-'+esc(t.id)+'">';
        html+='<button class="st-dropdown-item" data-complete-task="'+esc(t.id)+'">\u2713 Mark Complete</button>';
        html+='<button class="st-dropdown-item" data-start-task="'+esc(t.id)+'">\u25B6 Start / In Progress</button>';
        html+='<button class="st-dropdown-item" data-set-waiting="'+esc(t.id)+'" data-waiting="waiting_on_practice">\u23F3 Waiting on Practice</button>';
        html+='<button class="st-dropdown-item" data-set-waiting="'+esc(t.id)+'" data-waiting="waiting_on_gp">\u23F3 Waiting on GP</button>';
        html+='<div class="st-dropdown-sep"></div>';
        if(u.gp_email||c.gp_email){
          html+='<a class="st-dropdown-item" href="mailto:'+esc(u.gp_email||c.gp_email)+'" target="_blank">\u2709 Email GP</a>';
        }
        const dtUrl2=t.doubletick_conversation_url||u.doubletick_conversation_url||"";
        if(dtUrl2.indexOf("doubletick.io/conversations/")>-1){
          html+='<a class="st-dropdown-item" href="'+safeUrl(dtUrl2)+'" target="_blank">\uD83D\uDCAC WhatsApp</a>';
        }
        html+='<button class="st-dropdown-item" data-case-nudge="'+esc(c.user_id||"")+'" data-nudge-stage="'+esc(c.stage||"")+'" data-nudge-substage="" data-nudge-name="'+esc(((u.gp_name||c.gp_name||"").split(" ")[0]||"").trim())+'">\uD83D\uDCE8 Send Nudge</button>';
        html+='<div class="st-dropdown-sep"></div>';
        html+='<button class="st-dropdown-item" data-set-waiting="'+esc(t.id)+'" data-waiting="blocked">\uD83D\uDEA8 Escalate</button>';
        html+='</div>'; /* close dropdown */
        html+='</button>'; /* close more btn */
        html+='</div>'; /* close st-actions */
        html+='</div>'; /* close st-top */
        html+='</div>'; /* close stage-task */
      });
    }
    html+='</div>'; /* close stage-group */
  });

  html+='<div style="margin-top:12px"><button class="btn sm" data-add-task>+ Add Task</button></div>';
  return html;
}
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): stage-grouped tasks with guided next-action prompts"
```

---

### Task 7: Wire Up Event Handlers for New Components

**Files:**
- Modify: `pages/admin.html:2773+` (event delegation block)

- [ ] **Step 1: Add dropdown menu toggle handler**

In the main click event delegation block:

```javascript
/* ••• dropdown toggle */
if(e.target.closest("[data-more-menu]")){
  e.stopPropagation();
  const btn=e.target.closest("[data-more-menu]");
  const taskId=btn.getAttribute("data-more-menu");
  const dd=document.getElementById("dropdown-"+taskId);
  if(dd){
    /* Close all other dropdowns first */
    document.querySelectorAll(".st-dropdown.open").forEach(d=>{if(d!==dd)d.classList.remove("open");});
    dd.classList.toggle("open");
  }
  return;
}

/* Close dropdowns on outside click */
if(!e.target.closest(".st-dropdown")&&!e.target.closest("[data-more-menu]")){
  document.querySelectorAll(".st-dropdown.open").forEach(d=>d.classList.remove("open"));
}
```

- [ ] **Step 2: Add guided action handler**

```javascript
/* Guided action buttons */
if(e.target.closest("[data-guided-action]")){
  const btn=e.target.closest("[data-guided-action]");
  const action=btn.getAttribute("data-guided-action");
  const taskId=btn.getAttribute("data-task-id");
  const dk=btn.getAttribute("data-doc-key")||"";
  const task=(S.tasks||[]).find(t=>t.id===taskId);

  if(action==="completeTask"){completeTask(taskId);}
  else if(action==="previewDoc"){previewTaskDoc(taskId);}
  else if(action==="generatePD"){generatePositionDescription(taskId);}
  else if(action==="editPD"){openPDEditor(taskId);}
  else if(action==="emailPractice"){
    /* Find practice contact and build mailto */
    if(task){
      const pc=task.practice_contact||{};
      const gpName=task.gp_name||"the GP";
      const docLabel=dk==="offer_contract"?"Offer/Contract":"Supervisor CV";
      const subject=docLabel+" Required \u2014 "+gpName+" at "+(pc.practiceName||"the practice");
      const body="Hi "+(pc.contactName||"")+",\n\nWe require the "+docLabel.toLowerCase()+" for "+gpName+".\n\nPlease reply with the document attached.\n\nKind regards,\nGP Link Team";
      window.open(buildMailtoLinkFE(pc.contactEmail||"",subject,body));
      markTaskWaiting(taskId);
    }
  }
  else if(action==="openWhatsApp"){
    if(task){
      const url=task.doubletick_conversation_url||task.whatsapp_link||"";
      if(url)window.open(url,"_blank");
    }
  }
  else if(action==="sendSppa"){
    /* Trigger SPPA send if function exists */
    if(typeof sendSppaForSigning==="function")sendSppaForSigning(taskId);
  }
  else if(action==="checkSppaStatus"){
    if(typeof checkSppaStatus==="function")checkSppaStatus(taskId);
  }
  return;
}
```

- [ ] **Step 3: Add waiting status handler**

```javascript
/* Set waiting status from dropdown */
if(e.target.closest("[data-set-waiting]")){
  const btn=e.target.closest("[data-set-waiting]");
  const taskId=btn.getAttribute("data-set-waiting");
  const status=btn.getAttribute("data-waiting");
  updateTaskStatus(taskId,status);
  document.querySelectorAll(".st-dropdown.open").forEach(d=>d.classList.remove("open"));
  return;
}
```

- [ ] **Step 4: Add `updateTaskStatus()` helper if it doesn't exist**

Check if a generic task status update function exists. If not, add:

```javascript
async function updateTaskStatus(taskId,status){
  try{
    await fetch("/api/admin/task?id="+encodeURIComponent(taskId),{
      method:"PUT",credentials:"same-origin",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({status:status})
    });
    await loadAll(true);
    renderCaseList();renderDetail();
  }catch(err){console.error("[VA] updateTaskStatus failed",err);}
}
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): wire event handlers for guided actions, dropdowns, and status updates"
```

---

### Task 8: Update GP Sub-Tabs to Tasks + Notes Only

**Files:**
- Modify: `pages/admin.html:1900-1913` (tab rendering in `renderDetail()`)
- Modify: `pages/admin.html:2887` (sub-tab click handler)

- [ ] **Step 1: Verify renderDetail() uses new 2-tab layout**

This was already done in Task 4 Step 3, which changed the tabs to only show Tasks and Notes. Verify the sub-tab click handler at line ~2887 still works with just "tasks" and "notes" values — it should, since `S.gpsProfileTab` is just a string that gets checked.

- [ ] **Step 2: Update sub-tab click handler to handle only tasks/notes**

The existing handler at line ~2887 sets `S.gpsProfileTab` to whatever `data-gp-tab` value is clicked, then calls `renderDetail()`. This works as-is — clicking "tasks" or "notes" will re-render with the correct pane. No changes needed to the handler logic.

However, update the selector to use the new class:

```javascript
/* GP sub-tab click — update to use new .gp-subtab class */
if(e.target.closest("[data-gp-tab]")){
  S.gpsProfileTab=e.target.closest("[data-gp-tab]").getAttribute("data-gp-tab");
  renderDetail();
}
```

- [ ] **Step 3: Commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): consolidate GP sub-tabs to Tasks and Notes only"
```

---

### Task 9: Visual Testing and Polish

**Files:**
- Modify: `pages/admin.html` (various CSS tweaks)

- [ ] **Step 1: Start dev server and test**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
npm start
```

Open `http://localhost:3000/pages/admin.html` and verify:

1. **Top nav:** 4 tabs — GPs (active), Medical Centres, Support, Ops Queue
2. **GP list:** Priority lanes — Needs Action (red) and On Track (green)
3. **Profile bar:** Compact — avatar, name, email, phone, stage pill, WhatsApp/Nudge buttons, ▾ toggle
4. **Expand toggle:** Click ▾ → shows case management form (status, blocker, follow-up, practice name, handover notes)
5. **Journey rail:** Horizontal chevrons — ✓ Placement → ✓ MyIntealth → ✓ AMC → ● AHPRA → PBS → Commence
6. **Sub-tabs:** Tasks (with count) | Notes — no Documents or Journey tabs
7. **Task cards:** Grouped by stage, not priority. Each card shows title, guided prompt, primary action button, ••• menu
8. **••• dropdown:** Opens with grouped actions (complete, start, waiting, email, nudge, escalate)
9. **Locked stages:** Dimmed with lock icon and "Unlocks after X" badge
10. **Medical Centres tab:** Still works unchanged
11. **Support tab:** Still works unchanged
12. **Ops Queue tab:** Shows the operational table (was "Tools" tab)
13. **Clicking a GP:** Selects in list, shows detail panel with all new components
14. **Completing a task:** Click guided action or dropdown "Mark Complete" → task disappears, counts update

- [ ] **Step 2: Fix any CSS spacing or layout issues found during testing**

Common things to check:
- Profile bar on narrow screens — pills may wrap, verify it looks clean
- Journey rail overflow on small screens — should scroll horizontally
- Dropdown menu positioning — should not clip off-screen
- Stage group spacing — verify clear visual separation between groups

- [ ] **Step 3: Verify no regression on existing features**

- Medical Centres tab still loads and displays correctly
- Support tab still shows tickets and resolves them
- Ops Queue (formerly Tools) still loads ops table with filters
- Global search still finds GPs, tasks, tickets
- Sync button still works
- Logout still works
- Nudge modal still opens from the ••• dropdown

- [ ] **Step 4: Update cache busters**

Find all `<script>` and `<link>` tags in admin.html that have `?v=` cache busters and update to today's date:

```
?v=20260507a
```

- [ ] **Step 5: Final commit**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add pages/admin.html
git commit -m "feat(admin): VA command centre redesign — stage-grouped tasks, priority lanes, journey rail"
```

- [ ] **Step 6: Push to remote**

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git push origin main
```

---

## Self-Review Checklist

### Spec Coverage
| Spec Requirement | Task |
|---|---|
| GP list with priority lanes | Task 3 |
| Compact profile bar with expand toggle | Task 4 |
| Journey rail | Task 5 |
| Tasks + Notes sub-tabs (2 instead of 4) | Task 4 + Task 8 |
| Stage-grouped tasks | Task 6 |
| Guided next-action per task | Task 6 (getGuidedAction) |
| ••• dropdown menu | Task 6 + Task 7 |
| 4 top tabs (GPs, MC, Support, Ops Queue) | Task 2 |
| Documents inline on task cards | Task 6 (st-doc-info) |
| Case management in expand panel | Task 4 |

### No Placeholders
All code blocks are complete. No TBD, TODO, or "similar to Task N" references.

### Type Consistency
- `S.gpsProfileTab` values: `"tasks"` and `"notes"` — consistent across renderDetail(), tab click handler, sub-tab HTML
- `data-guided-action` values match the handler switch cases: `completeTask`, `previewDoc`, `generatePD`, `editPD`, `emailPractice`, `openWhatsApp`, `sendSppa`, `checkSppaStatus`
- `data-more-menu` / `data-set-waiting` / `data-complete-task` / `data-start-task` — all match existing handler patterns
