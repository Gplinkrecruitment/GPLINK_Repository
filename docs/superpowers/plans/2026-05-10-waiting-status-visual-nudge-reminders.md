# Waiting Status Visual Feedback & Nudge Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task waiting statuses visually prominent on task cards, and surface nudge reminders when tasks have been waiting 7+ days — both inline on task cards and as a counter in the Ops Queue.

**Architecture:** All changes are in `pages/admin.html` (CSS + JS). No backend changes needed — `updated_at` already tracks when a task's status last changed. The client calculates days-waiting from `updated_at` and uses 7-day threshold for nudge reminders.

**Tech Stack:** Vanilla JS/HTML/CSS (inline in admin.html), existing Supabase data.

---

### Task 1: Add CSS for waiting task card states

**Files:**
- Modify: `pages/admin.html:707-723` (CSS section)

- [ ] **Step 1: Add waiting card styles after line 723**

Add these CSS rules after the existing `.stage-task .st-waiting` rule at line 723:

```css
/* Waiting state card styling */
.stage-task.st-waiting-state{border-left:3px solid var(--amber);background:#fffbeb}
.stage-task .st-waiting-pill{display:inline-block;font-size:11px;font-weight:700;padding:3px 10px;border-radius:6px;background:#fef3c7;color:#b45309;margin-top:4px}
.stage-task .st-waiting-days{font-size:10px;color:var(--muted);margin-left:6px;font-weight:500}
/* Nudge follow-up reminder (7+ days waiting) */
.stage-task .st-nudge-reminder{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:11px;color:#dc2626;font-weight:600}
.stage-task .st-nudge-reminder .st-nudge-btn{padding:3px 10px;border-radius:6px;font-size:10px;font-weight:700;background:#7c3aed;color:#fff;border:none;cursor:pointer;font-family:inherit;margin-left:auto;white-space:nowrap}
.stage-task .st-nudge-reminder .st-nudge-btn:hover{background:#6d28d9}
```

- [ ] **Step 2: Add Ops Queue "Needs Follow-up" stat styling**

The existing `.ops-stat` classes already handle this. Add one color class after the existing `.ops-status-pill.waiting_on_practice` rule near line 190:

```css
.ops-stat .ops-stat-val.purple{color:#7c3aed}
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "style: add CSS for waiting task card states and nudge reminders"
```

---

### Task 2: Add waiting state class and days-waiting to task cards

**Files:**
- Modify: `pages/admin.html:1962-1994` (renderGpTasksPane task card rendering)

- [ ] **Step 1: Add days-waiting calculation inside the task forEach**

At line 1963, right after `const guided=getGuidedAction(t);`, add a days-waiting calculation:

```js
          const isWaiting=t.status==='waiting_on_practice'||t.status==='waiting_on_gp'||t.status==='waiting_on_external';
          const waitingDays=isWaiting&&t.updated_at?Math.floor((Date.now()-new Date(t.updated_at).getTime())/86400000):0;
          const needsNudge=isWaiting&&waitingDays>=7;
```

- [ ] **Step 2: Add the waiting class to the task card div**

At line 1969, the task card div is:
```js
          html+='<div class="stage-task'+(isNext?' active-next':'')+(t.task_type==='email_triage'?' unlocked-email':'')+'" data-task-row="'+esc(t.id)+'">';
```

Change it to:
```js
          html+='<div class="stage-task'+(isNext?' active-next':'')+(t.task_type==='email_triage'?' unlocked-email':'')+(isWaiting?' st-waiting-state':'')+'" data-task-row="'+esc(t.id)+'">';
```

- [ ] **Step 3: Replace the plain waiting text with a pill + days counter**

Replace lines 1988-1994:
```js
          if(t.status==='waiting_on_practice'){
            html+='<div class="st-waiting">\u23F3 Waiting on practice</div>';
          }else if(t.status==='waiting_on_gp'){
            html+='<div class="st-waiting">\u23F3 Waiting on GP</div>';
          }else if(t.status==='waiting_on_external'){
            html+='<div class="st-waiting">\u23F3 Waiting on external</div>';
          }
```

With:
```js
          if(isWaiting){
            var waitLabel=t.status==='waiting_on_practice'?'Waiting on practice':t.status==='waiting_on_gp'?'Waiting on GP':'Waiting on external';
            html+='<div><span class="st-waiting-pill">\u23F3 '+waitLabel+'</span>';
            if(waitingDays>0)html+='<span class="st-waiting-days">'+waitingDays+' day'+(waitingDays===1?'':'s')+'</span>';
            html+='</div>';
          }
```

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add visual waiting state styling and days counter to task cards"
```

---

### Task 3: Add inline nudge reminder on task cards waiting 7+ days

**Files:**
- Modify: `pages/admin.html` — inside the task card rendering block, after the waiting pill (added in Task 2), before `html+='</div>';` at the end of `st-body`

- [ ] **Step 1: Add nudge reminder row after the waiting pill block**

Right after the waiting pill block added in Task 2 (the `if(isWaiting)` block), and before `html+='</div>';` (the close of `st-body` at line 1996), add:

```js
          if(needsNudge){
            html+='<div class="st-nudge-reminder">\u26A0\uFE0F '+waitingDays+' days waiting \u2014 follow up?';
            html+='<button class="st-nudge-btn" data-case-nudge="'+esc(c.user_id||"")+'" data-nudge-stage="'+esc(c.stage||"")+'" data-nudge-substage="" data-nudge-name="'+esc(((u.gp_name||c.gp_name||"").split(" ")[0]||"").trim())+'">Send Nudge</button>';
            html+='</div>';
          }
```

This reuses the existing `data-case-nudge` attribute which is already handled by the click listener at line 3501 to open `openNudgeModal()`.

- [ ] **Step 2: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add inline nudge reminder for tasks waiting 7+ days"
```

---

### Task 4: Add "Needs Follow-up" counter to Ops Queue stats

**Files:**
- Modify: `pages/admin.html:3039-3052` (renderOpsStats function)

- [ ] **Step 1: Add needs-follow-up counter to renderOpsStats**

Replace the `renderOpsStats` function (lines 3039-3053):

```js
  function renderOpsStats(){
    const all=S.opsTasks;
    const now=new Date();
    const openC=all.filter(t=>t.status==="open").length;
    const urgentC=all.filter(t=>t.priority==="urgent").length;
    const overdueC=all.filter(t=>{if(!t.due_date&&!t.sla_due_date)return false;const d=new Date(t.sla_due_date||t.due_date);return d<now&&t.status!=="completed"&&t.status!=="cancelled";}).length;
    const waitGp=all.filter(t=>t.status==="waiting_on_gp").length;
    const waitPrac=all.filter(t=>t.status==="waiting_on_practice").length;
    document.getElementById("opsStats").innerHTML=
      `<div class="ops-stat"><div class="ops-stat-val blue">${openC}</div><div class="ops-stat-label">Open Tasks</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val red">${urgentC}</div><div class="ops-stat-label">Urgent</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val ${overdueC?"red":""}">${overdueC}</div><div class="ops-stat-label">Overdue</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val amber">${waitGp}</div><div class="ops-stat-label">Waiting on GP</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val amber">${waitPrac}</div><div class="ops-stat-label">Waiting on Practice</div></div>`;
  }
```

With:

```js
  function renderOpsStats(){
    const all=S.opsTasks;
    const now=new Date();
    const openC=all.filter(t=>t.status==="open").length;
    const urgentC=all.filter(t=>t.priority==="urgent").length;
    const overdueC=all.filter(t=>{if(!t.due_date&&!t.sla_due_date)return false;const d=new Date(t.sla_due_date||t.due_date);return d<now&&t.status!=="completed"&&t.status!=="cancelled";}).length;
    const waitGp=all.filter(t=>t.status==="waiting_on_gp").length;
    const waitPrac=all.filter(t=>t.status==="waiting_on_practice").length;
    const needsFollowUp=all.filter(t=>(t.status==="waiting_on_gp"||t.status==="waiting_on_practice"||t.status==="waiting_on_external")&&t.updated_at&&Math.floor((now.getTime()-new Date(t.updated_at).getTime())/86400000)>=7).length;
    document.getElementById("opsStats").innerHTML=
      `<div class="ops-stat"><div class="ops-stat-val blue">${openC}</div><div class="ops-stat-label">Open Tasks</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val red">${urgentC}</div><div class="ops-stat-label">Urgent</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val ${overdueC?"red":""}">${overdueC}</div><div class="ops-stat-label">Overdue</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val amber">${waitGp}</div><div class="ops-stat-label">Waiting on GP</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val amber">${waitPrac}</div><div class="ops-stat-label">Waiting on Practice</div></div>`+
      `<div class="ops-stat"><div class="ops-stat-val ${needsFollowUp?"purple":""}">${needsFollowUp}</div><div class="ops-stat-label">Needs Follow-up</div></div>`;
  }
```

- [ ] **Step 2: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Needs Follow-up counter to Ops Queue stats"
```

---

### Task 5: Add "Needs Follow-up" filter option to Ops Queue

**Files:**
- Modify: `pages/admin.html:816-824` (opsStatus select) and `pages/admin.html:3017-3037` (loadOpsQueue function)

- [ ] **Step 1: Add filter option to the opsStatus dropdown**

At line 823, after the `<option value="all_active">All Active</option>` line, add:

```html
          <option value="needs_followup">Needs Follow-up (7+ days)</option>
```

- [ ] **Step 2: Handle the new filter in loadOpsQueue**

In `loadOpsQueue()`, after the line at 3026:
```js
    if(status==="all_active")url+="&status=open,in_progress,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked";
```

Add:
```js
    if(status==="needs_followup")url+="&status=waiting_on_gp,waiting_on_practice,waiting_on_external&stale_days=7";
```

- [ ] **Step 3: Handle `stale_days` parameter on the server**

In `server.js`, find the `/api/admin/ops/queue` endpoint. After the existing query building for status/domain/priority/overdue filters, add filtering for `stale_days`:

Find the ops queue endpoint:
```js
if (pathname === '/api/admin/ops/queue' && req.method === 'GET') {
```

After the existing filter building that constructs the Supabase query params, add:

```js
    const staleDays = url.searchParams.get('stale_days');
    if (staleDays) {
      const cutoff = new Date(Date.now() - parseInt(staleDays) * 86400000).toISOString();
      qp += '&updated_at=lt.' + encodeURIComponent(cutoff);
    }
```

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html server.js
git commit -m "feat: add Needs Follow-up filter to Ops Queue with server-side stale_days support"
```

---

### Task 6: Add "waiting since" badge to Ops Queue table rows

**Files:**
- Modify: `pages/admin.html:3055-3096` (renderOpsTable function)

- [ ] **Step 1: Add waiting-since indicator to ops table rows**

In `renderOpsTable()`, inside the row rendering at line 3068, after the status pill:

```js
        <td><span class="ops-status-pill ${esc(t.status||"")}">${esc(statusLabel)}</span></td>
```

The status pill already shows "waiting on practice" etc. To add days-waiting info, modify the status pill line to include the days count when the task is in a waiting state:

Replace line 3068:
```js
        <td><span class="ops-status-pill ${esc(t.status||"")}">${esc(statusLabel)}</span></td>
```

With:
```js
        <td><span class="ops-status-pill ${esc(t.status||"")}">${esc(statusLabel)}</span>${(t.status==="waiting_on_gp"||t.status==="waiting_on_practice"||t.status==="waiting_on_external")&&t.updated_at?(() => { const wd=Math.floor((Date.now()-new Date(t.updated_at).getTime())/86400000); return wd>0?' <span style="font-size:10px;color:'+(wd>=7?'#dc2626':'var(--muted)')+';font-weight:'+(wd>=7?'700':'500')+'">'+wd+'d</span>':''; })():''}</td>
```

- [ ] **Step 2: Commit**

```bash
git add pages/admin.html
git commit -m "feat: show days-waiting count in Ops Queue table rows"
```

---

### Task 7: Verify and test

- [ ] **Step 1: Start the dev server**

```bash
npm start
```

- [ ] **Step 2: Open admin.html in browser, select a GP with tasks, and test:**

1. Click ⋯ on a task → click "Waiting on Practice"
2. Verify the task card gets an amber left border + amber background
3. Verify the waiting pill shows "⏳ Waiting on practice"
4. Verify the days counter shows (will be "0 days" for a freshly set task)
5. For any task already waiting 7+ days, verify the red nudge reminder row appears with "Send Nudge" button
6. Click "Send Nudge" on the reminder → verify the nudge modal opens

- [ ] **Step 3: Test the Ops Queue**

1. Navigate to Ops Queue tab
2. Verify the "Needs Follow-up" counter appears with the correct count
3. Select "Needs Follow-up (7+ days)" from the status filter
4. Verify only stale waiting tasks appear

- [ ] **Step 4: Final commit with cache buster update**

Update any cache busters on admin.html script tags if applicable, then commit:

```bash
git add pages/admin.html
git commit -m "feat: waiting status visual feedback and nudge reminders complete"
```
