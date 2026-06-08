# ELS Pathway Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let GPs select their AHPRA English Language Skills pathway in-app and show that selection + required documents to admin.

**Architecture:** Inline dropdown + checklist in Row 3 of the AHPRA Application step. Selection saved to `gp_ahpra_progress.els_pathway` via existing state-sync. Admin dashboard API exposes the field; admin profile renders it with the document list.

**Tech Stack:** Vanilla JS/HTML (existing patterns), server.js API modification

**Spec:** `docs/superpowers/specs/2026-06-09-els-pathway-tracking-design.md`

---

### Task 1: Add ELS pathway dropdown and checklist to AHPRA page

**Files:**
- Modify: `pages/ahpra.html:3815-3823` (Row 3 rendering in `renderQuickPrep` function)
- Modify: `pages/ahpra.html` (add CSS styles near existing `.qp-*` styles, ~line 533-619)
- Modify: `pages/ahpra.html` (add save/load logic in script section)

- [ ] **Step 1: Add CSS styles for the ELS dropdown and checklist**

Add these styles after line 619 (after `.qp-copy-btn.copied` rule) in the `<style>` block:

```css
/* ---- ELS PATHWAY ---- */
.els-select-wrap { margin-top: 10px; }
.els-select-label {
  font-size: 11px; font-weight: 600; color: var(--ink-muted);
  text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;
}
.els-select {
  width: 100%; padding: 8px 12px;
  font-size: 13px; font-weight: 500; font-family: var(--font-body, 'DM Sans', sans-serif);
  color: var(--ink); background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%237c849b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 5l3 3 3-3'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center;
}
.els-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
.els-checklist {
  margin-top: 12px; padding: 12px 14px;
  background: #f0f5ff; border: 1px solid #d4e0f7; border-radius: 10px;
  animation: elsSlide 0.25s ease;
}
@keyframes elsSlide { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
.els-checklist-title {
  font-size: 12px; font-weight: 700; color: var(--accent);
  margin-bottom: 8px; display: flex; align-items: center; gap: 6px;
}
.els-checklist-title svg { width: 14px; height: 14px; }
.els-checklist ul { list-style: none; padding: 0; margin: 0; }
.els-checklist li {
  font-size: 12px; color: var(--ink-soft); line-height: 1.5;
  padding: 3px 0 3px 20px; position: relative;
}
.els-checklist li::before {
  content: ''; position: absolute; left: 0; top: 7px;
  width: 12px; height: 12px; border: 1.5px solid var(--border);
  border-radius: 3px; background: #fff;
}
.els-saved-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; color: var(--success); margin-top: 8px;
}
.els-saved-badge svg { width: 12px; height: 12px; }
```

- [ ] **Step 2: Add the ELS_PATHWAY_DOCS constant**

Add this constant in the script section, after the `STORAGE_KEY` constant declaration at line 2198:

```js
const ELS_PATHWAY_DOCS = {
  combined: {
    title: "Combined Education Pathway",
    docs: [
      "Official transcripts showing qualification taught & assessed in English",
      "Details of secondary education provider and enrolment dates (entered in AHPRA form)",
      "Letter from education provider confirming English instruction (if not shown on transcript)"
    ]
  },
  school: {
    title: "School Education Pathway",
    docs: [
      "Details of primary & secondary education providers and enrolment dates (entered in AHPRA form)",
      "Official transcripts showing qualification taught & assessed in English",
      "Letter from education provider confirming English instruction (if not shown on transcript)",
      "Home schooling evidence from Department of Education (if applicable)"
    ]
  },
  advanced: {
    title: "Advanced Education Pathway",
    docs: [
      "Official transcripts of professional qualification",
      "Official transcripts of advanced education (degree level AQF 7+)",
      "Letter from education provider confirming English instruction (if not shown on transcript)",
      "Dates of any breaks taken during study (entered in AHPRA form)",
      "Date of most recent study completion (must be within 2 years of application)"
    ]
  },
  test: {
    title: "Test Pathway",
    docs: [
      "Copy of test results with candidate number (IELTS / OET / PTE / TOEFL / Cambridge)",
      "PTE Academic only: authorise AHPRA to access results through PTE system",
      "If test > 2 years old + still working: CV in AHPRA format + employer letter confirming continuous employment",
      "If test > 2 years old + enrolled in study: transcript showing continuous enrolment in Board-approved program",
      "PLAB or NZREX: certified copy of test results (medicine applicants only)"
    ]
  },
  native: {
    title: "Native English Speaker",
    docs: [
      "No additional documents required \u2014 your country of training qualifies you automatically",
      "Confirm your recognised country in the AHPRA application form"
    ]
  }
};
```

- [ ] **Step 3: Add helper function to build the checklist HTML**

Add this function after the `ELS_PATHWAY_DOCS` constant:

```js
function buildElsChecklistHtml(pathwayKey) {
  var pw = ELS_PATHWAY_DOCS[pathwayKey];
  if (!pw) return '';
  var docSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V6L9 1.5z"/><path d="M9 1.5V6h4.5M10.5 9.5h-5M10.5 12h-5M6 7H5.5"/></svg>';
  var checkSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 4.5 6 12 2.5 8.5"/></svg>';
  var items = pw.docs.map(function (d) { return '<li>' + d + '</li>'; }).join('');
  return '<div class="els-checklist">' +
    '<div class="els-checklist-title">' + docSvg + ' Documents for ' + pw.title + '</div>' +
    '<ul>' + items + '</ul>' +
    '<div class="els-saved-badge">' + checkSvg + ' Pathway saved \u2014 visible to your GP Link team</div>' +
    '</div>';
}
```

- [ ] **Step 4: Replace Row 3 rendering with dropdown + checklist**

Replace the Row 3 block at lines 3815-3823 with:

```js
      // Row 3: English language skills
      var savedElsPathway = '';
      try {
        var _elsState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        savedElsPathway = _elsState.els_pathway || '';
      } catch (e) {}
      var elsOptions = [
        { key: '', label: '\u2014 Choose your ELS pathway \u2014' },
        { key: 'combined', label: 'Combined Education Pathway' },
        { key: 'school', label: 'School Education Pathway' },
        { key: 'advanced', label: 'Advanced Education Pathway' },
        { key: 'test', label: 'Test Pathway (IELTS, OET, PTE, TOEFL, Cambridge)' },
        { key: 'native', label: 'Native English Speaker (recognised country)' }
      ];
      var elsOptionsHtml = elsOptions.map(function (o) {
        return '<option value="' + o.key + '"' + (o.key === savedElsPathway ? ' selected' : '') + '>' + o.label + '</option>';
      }).join('');
      var row3 = '<div class="qp-row">' +
        '<div class="qp-num">3</div>' +
        '<div class="qp-body">' +
          '<div class="qp-label">English language skills</div>' +
          '<div class="qp-desc">Determine which pathway you are eligible for based on your training and practice history.</div>' +
          '<a href="https://www.ahpra.gov.au/Registration/Registration-Standards/English-language-skills.aspx#form-top" target="_blank" rel="noopener noreferrer" class="qp-link">' + extSvg + ' Check your eligibility on AHPRA</a>' +
          '<div class="els-select-wrap">' +
            '<div class="els-select-label">Select your pathway</div>' +
            '<select class="els-select" id="elsPathwaySelect">' + elsOptionsHtml + '</select>' +
          '</div>' +
          '<div id="elsChecklistContainer">' + buildElsChecklistHtml(savedElsPathway) + '</div>' +
        '</div>' +
      '</div>';
```

- [ ] **Step 5: Add change handler to save selection and update checklist**

Add this event listener in the main event delegation block (the `document.addEventListener("click", ...)` section). Find the section that handles other `qp-copy-btn` clicks and add nearby, or add as a dedicated listener after `renderQuickPrep` is called. Add after the tutorial toggle handler (~line 4232):

```js
    // ELS pathway selection handler
    document.addEventListener("change", function (e) {
      if (e.target && e.target.id === "elsPathwaySelect") {
        var selectedKey = e.target.value;
        var container = document.getElementById("elsChecklistContainer");
        if (container) container.innerHTML = buildElsChecklistHtml(selectedKey);
        // Save to state
        try {
          var ahpraState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
          if (selectedKey) {
            ahpraState.els_pathway = selectedKey;
          } else {
            delete ahpraState.els_pathway;
          }
          ahpraState.updatedAt = new Date().toISOString();
          localStorage.setItem(STORAGE_KEY, JSON.stringify(ahpraState));
          if (typeof flushBatchedSave === 'function') flushBatchedSave(STORAGE_KEY);
          if (selectedKey) showToast("ELS pathway saved");
        } catch (e) {}
      }
    });
```

- [ ] **Step 6: Commit**

```bash
git add pages/ahpra.html
git commit -m "Add ELS pathway dropdown + checklist to AHPRA Application step"
```

---

### Task 2: Expose ELS pathway in admin dashboard API

**Files:**
- Modify: `server.js:29531-29558` (admin VA dashboard user object builder)

- [ ] **Step 1: Extract els_pathway from user state and add to user object**

In `server.js`, in the `/api/admin/va/dashboard` handler, find the `users.push({` block at line 29531. The user state for each GP is available in `st` (from `stateMap[c.user_id]`). Add `els_pathway` to the user object.

Find the line that reads (around line 29505-29510):

```js
      var st = stateMap[c.user_id] || {};
```

After this line (and before `users.push`), add:

```js
      var _ahpraP = st.gp_ahpra_progress;
      if (typeof _ahpraP === 'string') try { _ahpraP = JSON.parse(_ahpraP); } catch (e) { _ahpraP = {}; }
      if (!_ahpraP || typeof _ahpraP !== 'object') _ahpraP = {};
      var elsPathway = _ahpraP.els_pathway || '';
```

Then in the `users.push({` object, add `els_pathway: elsPathway` after the `myintealth_id` field at line 29557:

```js
        myintealth_id: visibleMyintealthId,
        els_pathway: elsPathway
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "Expose ELS pathway in admin dashboard API response"
```

---

### Task 3: Display ELS pathway + document checklist on admin GP profile

**Files:**
- Modify: `pages/admin.html` (renderDetail function area, ~line 3174-3213)

- [ ] **Step 1: Add the ELS_PATHWAY_DOCS constant to admin page**

Add this constant in the admin page's `<script>` section, near the other constants (after `STAGE_ORDER` at line 1431):

```js
  const ELS_PATHWAY_DOCS = {
    combined: { title: "Combined Education Pathway", docs: ["Official transcripts showing qualification taught & assessed in English", "Details of secondary education provider and enrolment dates (entered in AHPRA form)", "Letter from education provider confirming English instruction (if not shown on transcript)"] },
    school: { title: "School Education Pathway", docs: ["Details of primary & secondary education providers and enrolment dates (entered in AHPRA form)", "Official transcripts showing qualification taught & assessed in English", "Letter from education provider confirming English instruction (if not shown on transcript)", "Home schooling evidence from Department of Education (if applicable)"] },
    advanced: { title: "Advanced Education Pathway", docs: ["Official transcripts of professional qualification", "Official transcripts of advanced education (degree level AQF 7+)", "Letter from education provider confirming English instruction (if not shown on transcript)", "Dates of any breaks taken during study (entered in AHPRA form)", "Date of most recent study completion (must be within 2 years of application)"] },
    test: { title: "Test Pathway", docs: ["Copy of test results with candidate number (IELTS / OET / PTE / TOEFL / Cambridge)", "PTE Academic only: authorise AHPRA to access results through PTE system", "If test > 2 years old + still working: CV in AHPRA format + employer letter confirming continuous employment", "If test > 2 years old + enrolled in study: transcript showing continuous enrolment in Board-approved program", "PLAB or NZREX: certified copy of test results (medicine applicants only)"] },
    native: { title: "Native English Speaker", docs: ["No additional documents required \u2014 country of training qualifies automatically", "Confirm recognised country in the AHPRA application form"] }
  };
```

- [ ] **Step 2: Add CSS for the admin ELS display**

Add these styles in the admin page `<style>` block (after the existing `.gp-profile-section` styles around line 445):

```css
.els-admin-card{background:#f0f5ff;border:1px solid #d4e0f7;border-radius:8px;padding:10px 14px;margin-top:8px}
.els-admin-title{font-size:12px;font-weight:700;color:#1a56db;margin-bottom:6px}
.els-admin-list{list-style:none;padding:0;margin:0}
.els-admin-list li{font-size:11px;color:#3d4663;line-height:1.5;padding:2px 0 2px 18px;position:relative}
.els-admin-list li::before{content:'';position:absolute;left:0;top:6px;width:10px;height:10px;border:1.5px solid #d4e0f7;border-radius:2px;background:#fff}
```

- [ ] **Step 3: Render ELS pathway in the profile bar area**

In the `renderDetail` function, find the profile bar HTML construction (around line 3174-3194). After the profile bar `pb-pills` div (line 3186, after the "View as GP" button), add an ELS pathway row below the profile bar.

Find the line:

```js
        </div>
        <div class="pb-expand-panel" id="pbExpandPanel">
```

Insert before it (after the profile bar closing div):

```js
        ${u.els_pathway && ELS_PATHWAY_DOCS[u.els_pathway] ? `
        <div class="gp-profile-section" style="margin-top:8px;padding:12px 16px">
          <h3 style="margin-bottom:6px">English Language Skills</h3>
          <div style="font-size:12px;font-weight:600;color:#0c1222;margin-bottom:4px">${esc(ELS_PATHWAY_DOCS[u.els_pathway].title)}</div>
          <div class="els-admin-card">
            <div class="els-admin-title">Required Documents</div>
            <ul class="els-admin-list">${ELS_PATHWAY_DOCS[u.els_pathway].docs.map(d=>'<li>'+esc(d)+'</li>').join('')}</ul>
          </div>
        </div>` : ''}
```

Note: `u` is the dashboard user object which now includes `els_pathway` from Task 2.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "Show ELS pathway + document checklist on admin GP profile"
```

---

### Task 4: Clean up mockup and deploy

**Files:**
- Delete: `pages/_els-mockup.html`

- [ ] **Step 1: Remove the mockup file**

```bash
rm pages/_els-mockup.html
```

- [ ] **Step 2: Kill the mockup server if still running**

```bash
kill $(lsof -ti:8888) 2>/dev/null || true
```

- [ ] **Step 3: Update cache buster on ahpra.html script tag**

In `pages/ahpra.html`, update any self-referencing cache buster version strings if present (e.g. in the `<script>` tags at the top of the file). Use `?v=20260609a`.

- [ ] **Step 4: Commit all changes**

```bash
git add -A
git commit -m "Clean up ELS mockup, update cache busters"
```

- [ ] **Step 5: Push and deploy**

```bash
git push
vercel --prod --yes
```
