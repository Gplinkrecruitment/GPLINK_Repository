# Registration Pages UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retouch all 6 registration pages to use a compact dark header, Source Serif 4 + DM Sans typography, minimal card-free layout, and refined color palette.

**Architecture:** Each page's inline `<style>` block is rewritten with the new design system CSS. HTML is restructured: the current `.app-header` + `.step-tabs` + `.step-content` pattern becomes `.hero-compact` (dark header with tabs) + flat content on the light surface. JS tab-switching logic is preserved — only CSS class names and the progress-line calculation change.

**Tech Stack:** Vanilla HTML/CSS/JS, Google Fonts (Source Serif 4 + DM Sans)

**Design spec:** `docs/superpowers/specs/2026-04-24-registration-pages-redesign.md`
**Visual mockup reference:** `.superpowers/brainstorm/1191-1777032247/content/final-preview-v4.html`

---

### Task 1: Rewrite myinthealth.html — CSS + HTML + progress line JS

This is the **template page**. All subsequent step pages (Tasks 2-4) follow the same pattern established here.

**Files:**
- Modify: `pages/myinthealth.html` (lines 16-752 CSS, lines 754-905 HTML structure)

**Reference:** Read the design spec at `docs/superpowers/specs/2026-04-24-registration-pages-redesign.md` and the visual mockup at `.superpowers/brainstorm/1191-1777032247/content/final-preview-v4.html` before making changes.

- [ ] **Step 1: Replace the font imports**

Replace the Inter font import (line 15) with:

```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap" rel="stylesheet" />
```

- [ ] **Step 2: Replace the CSS variables block**

Replace the existing `:root` block (lines 17-31) with the new design system variables from the spec — the full `--ink`, `--ink-soft`, `--ink-muted`, `--surface`, `--border`, `--border-light`, `--accent`, `--success`, `--warn-*`, `--hero-*`, `--sp-*`, `--font-heading`, `--font-body` set. See spec section "Color Palette" and "Spacing".

- [ ] **Step 3: Rewrite the full CSS**

Replace the entire `<style>` block content (lines 16-752) with the new design system CSS. Key changes:

1. **Body**: Change `font-family` to `var(--font-body)`, background to `var(--surface)`
2. **Remove all old component styles**: `.app-header`, `.header-*`, `.step-tabs`, `.step-tab`, `.step-tab-glass`, `.step-tab-num`, `.step-content`, `.step-content::before`, `.step-content-badge`, `.step-info-grid`, `.step-info-item`, `.tutorial-card`, `.btn-action` — all of these are replaced
3. **Add new component styles** per the spec:
   - `.hero-compact` — dark header with gradient, noise texture `::before`, `border-radius: 0 0 20px 20px`
   - `.hero-compact-pad` — padding container (desktop: `20px 28px 16px`, mobile: `16px 20px 12px`)
   - `.hero-header`, `.hero-left`, `.hero-avatar`, `.hero-name`, `.hero-sub-text`, `.hero-icons`, `.hero-icon-btn` — header row components
   - `.step-eyebrow` — uppercase step indicator
   - `.tabs-track` — relative container for progress line
   - `.tabs-progress-fill` — green line, `position: absolute; top: 50%; height: 2px; background: var(--success); z-index: 0`
   - `.step-tabs` (now just `.tabs`) — `position: relative; z-index: 1; display: flex; gap: 3px`
   - `.tab`, `.tab.active`, `.tab.done`, `.tab-n` — new tab styles per spec section 5
   - `.reg-content` — light surface area, `background: var(--surface); padding: 24px 28px 40px` (mobile: `20px 16px 100px`)
   - `.step-title` — `font-family: var(--font-heading); font-size: 28px` (mobile: 23px)
   - `.step-desc` — body description text
   - `.tut-toggle`, `.tut-dot`, `.tut-caret`, `.tut-video-wrap` — collapsible tutorial
   - `.warn`, `.warn-title`, `.warn-text` — left-border warning
   - `.info-rows`, `.info-row`, `.info-label`, `.info-val` — flat label:value rows
   - `.btn-primary`, `.btn-ghost` — button styles per spec section 10
   - `.action-card` — only for interactive groups
   - `.btn-row` — button container with mobile stacking
4. **Responsive `@media (max-width: 860px)`**: sticky dark header, smaller fonts, full-width stacked buttons, 100px bottom padding, 44px touch targets on icon buttons

- [ ] **Step 4: Restructure the HTML body**

Replace the current HTML structure (from `<body>` through the content area, before `<script>`) with the new layout:

1. **Dark header section**: Wrap the current `.app-header` and `.step-tabs` in a new `.hero-compact` container:
   ```html
   <div class="hero-compact">
     <div class="hero-compact-pad">
       <!-- Header row: avatar + page name + icons -->
       <div class="hero-header">
         <div class="hero-left">
           <div class="hero-avatar" id="headerAvatar">KM</div>
           <div>
             <div class="hero-name">MyIntealth</div>
             <div class="hero-sub-text">Health insurance & registration</div>
           </div>
         </div>
         <div class="hero-icons">
           <!-- keep existing bell/settings buttons, restyle with .hero-icon-btn -->
         </div>
       </div>
       <!-- Step eyebrow -->
       <div class="step-eyebrow" id="stepEyebrow">Step 1 of 4</div>
       <!-- Tabs with progress line -->
       <div class="tabs-track" id="tabsTrack">
         <div class="tabs-progress-fill" id="tabsProgressFill"></div>
         <nav class="tabs" id="stepTabs" aria-label="Step navigation"></nav>
       </div>
     </div>
   </div>
   ```
2. **Light content area**: Replace the `.step-content` card with flat content:
   ```html
   <div class="reg-content">
     <h2 class="step-title" id="stepTitle">Create Your Account</h2>
     <p class="step-desc" id="stepDesc">...</p>
     <!-- Tutorial toggle (replaces tutorial-card) -->
     <!-- Warning (replaces step-content-warning) -->
     <!-- Info rows (replaces step-info-grid) -->
     <!-- Buttons (replaces step-actions) -->
   </div>
   ```
3. **Remove**: `.step-tab-glass`, `.step-content::before` stripe, `.step-content-badge`, `.step-info-grid`/`.step-info-item` containers, `.tutorial-card` wrapper
4. **Convert info grids to info rows**: Each `.step-info-item` with label+value becomes a flat `.info-row` with `.info-label` and `.info-val` spans
5. **Convert tutorial card to collapsible**: Replace the `.tutorial-card` with a `.tut-toggle` button + `.tut-video-wrap` div
6. **Convert warning boxes**: Replace `.step-content-warning` with `.warn` (left-border only)
7. **Convert buttons**: Replace `.btn-action.primary` / `.btn-action.secondary` with `.btn-primary` / `.btn-ghost`

- [ ] **Step 5: Update the JS tab rendering to emit new class names**

In the `<script>` block, find the function that renders tabs (the function that creates `.step-tab` elements and appends them to `#stepTabs`). Update it to:

1. Emit `.tab` instead of `.step-tab`, `.tab-n` instead of `.step-tab-num`
2. Add `.tab.active`, `.tab.done` states
3. Remove the glass element positioning code (`.step-tab-glass` is removed)
4. After rendering tabs, call `updateProgressFill()` to set the green line width

- [ ] **Step 6: Add the progress line JS function**

Add this function to the `<script>` block:

```javascript
function updateProgressFill() {
  var tabsEl = document.getElementById('stepTabs');
  var fill = document.getElementById('tabsProgressFill');
  var active = tabsEl && tabsEl.querySelector('.tab.active');
  if (!active || !tabsEl || !fill) { fill && (fill.style.width = '0px'); return; }
  fill.style.width = active.offsetLeft + 'px';
}
```

Call `updateProgressFill()` at the end of every tab render/switch. Also add a resize listener:

```javascript
window.addEventListener('resize', updateProgressFill);
```

- [ ] **Step 7: Update the step eyebrow text**

In the `renderPage` or equivalent function, after determining the current step index and total steps, update the eyebrow:

```javascript
var eyebrow = document.getElementById('stepEyebrow');
if (eyebrow) eyebrow.textContent = 'Step ' + (currentIndex + 1) + ' of ' + totalSteps;
```

- [ ] **Step 8: Add collapsible tutorial toggle JS**

Add a click handler for `.tut-toggle` buttons:

```javascript
document.addEventListener('click', function(e) {
  var toggle = e.target.closest('.tut-toggle');
  if (!toggle) return;
  toggle.classList.toggle('open');
  var wrap = toggle.nextElementSibling;
  if (wrap && wrap.classList.contains('tut-video-wrap')) {
    wrap.classList.toggle('open');
  }
});
```

- [ ] **Step 9: Update cache buster versions**

Update all `?v=` suffixes on script tags in this file to `?v=20260424b`.

- [ ] **Step 10: Test in browser**

Run `npm start` and navigate to `/pages/myinthealth.html`. Verify:
- Dark header renders with rounded bottom corners
- Step tabs display with correct active/done states
- Green progress line stops at left edge of active tab
- Step title appears on light surface in Source Serif 4
- Info displays as flat rows with dividers
- Tutorial link toggles video area
- Warning uses left-border accent
- Buttons styled correctly (dark primary, ghost back)
- Mobile view: sticky header, stacked buttons, scrollable tabs
- Also test inside the app shell at `/pages/app-shell.html` navigating to myinthealth

- [ ] **Step 11: Commit**

```bash
git add pages/myinthealth.html
git commit -m "feat: redesign myinthealth registration page with dark header and minimal layout"
```

---

### Task 2: Rewrite amc.html

**Files:**
- Modify: `pages/amc.html` (lines 16-688 CSS, lines 690-844 HTML)

**Reference:** Use `pages/myinthealth.html` (after Task 1) as the template. The CSS is nearly identical. Read the full file first to understand AMC-specific content.

- [ ] **Step 1: Replace font imports** — same as Task 1 Step 1
- [ ] **Step 2: Replace CSS** — copy the full `<style>` block from the completed `pages/myinthealth.html` and paste it into `pages/amc.html`, replacing lines 16-688. No AMC-specific CSS differences.
- [ ] **Step 3: Restructure HTML** — apply the same `.hero-compact` + `.reg-content` pattern from Task 1. AMC-specific changes:
  - Page name: "AMC Portfolio"
  - Subtitle: "AMC Candidate Portfolio Process"
  - The AMC page has 5 step tabs (vs 4 for myinthealth) — the tab rendering JS handles this dynamically
  - Convert all `.step-info-grid`/`.step-info-item` to `.info-rows`/`.info-row`
  - Convert `.tutorial-card` to `.tut-toggle` + `.tut-video-wrap`
  - Convert warning boxes and buttons
- [ ] **Step 4: Update JS** — same changes as Task 1 Steps 5-8: new tab class names, add `updateProgressFill()`, update eyebrow, add tutorial toggle handler
- [ ] **Step 5: Update cache busters** to `?v=20260424b`
- [ ] **Step 6: Test** — same verification checklist as Task 1 Step 10, but for AMC content
- [ ] **Step 7: Commit**

```bash
git add pages/amc.html
git commit -m "feat: redesign AMC registration page with dark header and minimal layout"
```

---

### Task 3: Rewrite ahpra.html

**Files:**
- Modify: `pages/ahpra.html` (lines 16-908 CSS, lines 910-1129 HTML)

**Reference:** Use `pages/myinthealth.html` (after Task 1) as the template. Read the full file first — AHPRA has a **placement gate** section that must be preserved.

- [ ] **Step 1: Replace font imports** — same as Task 1 Step 1
- [ ] **Step 2: Replace CSS** — copy the `<style>` block from completed `pages/myinthealth.html`. Then **add back** the placement gate styles (`.placement-gate`, `.gate-bg`, `.gate-blob`, `.gate-doctor`, `.gate-content`, etc.) from the original AHPRA file. These styles are AHPRA-specific and must be preserved.
- [ ] **Step 3: Restructure HTML** — apply `.hero-compact` + `.reg-content` pattern. AHPRA-specific:
  - Page name: "AHPRA Registration"
  - Subtitle: "Specialist Registration Process"
  - **Preserve the placement gate section** (`.placement-gate` div) — this full-screen gate blocks access until placement is secured. Do not move or restructure it.
  - The gate visibility logic in JS checks `progress.placement_secured` — leave this JS logic untouched
  - Convert info grids, warnings, tutorial, buttons same as Task 1
- [ ] **Step 4: Update JS** — same tab class name changes, add `updateProgressFill()`, eyebrow, tutorial toggle. **Do not modify** placement gate JS logic.
- [ ] **Step 5: Update cache busters** to `?v=20260424b`
- [ ] **Step 6: Test** — verify placement gate still blocks when placement not secured, verify registration steps render correctly when gate passes
- [ ] **Step 7: Commit**

```bash
git add pages/ahpra.html
git commit -m "feat: redesign AHPRA registration page with dark header and minimal layout"
```

---

### Task 4: Rewrite pbs.html

**Files:**
- Modify: `pages/pbs.html` (lines 16-564 CSS, lines 566-767 HTML)

**Reference:** Use `pages/myinthealth.html` (after Task 1) as the CSS template. PBS has a **different step structure** — it uses a 2-step `.pbs-stepper` instead of the multi-tab `.step-tabs`. Read the full file first.

- [ ] **Step 1: Replace font imports** — same as Task 1 Step 1
- [ ] **Step 2: Replace CSS** — copy the base design system variables and shared component styles from completed `pages/myinthealth.html`. Then adapt PBS-specific styles:
  - Replace `.pbs-stepper` / `.pbs-step` / `.pbs-step-dot` / `.pbs-step-connector` with the new `.tabs` / `.tab` / `.tab-n` styles from the spec. PBS only has 2 steps so the tabs will be simpler.
  - Replace `.case-summary`, `.case-meta` with `.info-rows` / `.info-row` styles
  - Replace `.step-section`, `.step-section-header`, `.step-meta` with flat content styles
  - Replace `.doc-list`, `.doc-row` styles — these are interactive document lists that should use `.action-card` styling (cards are allowed for interactive groups)
  - Replace `.doc-status` badges with minimal inline status text
- [ ] **Step 3: Restructure HTML** — apply `.hero-compact` + `.reg-content` pattern:
  - Page name: "PBS & Medicare"
  - Subtitle: "Provider number setup"
  - Convert the `.pbs-stepper` to `.tabs-track` + `.tabs` with 2 tab items
  - Convert `.case-summary` to flat content (title, description, info rows)
  - Convert `.step-section` blocks to flat sections with `.sec-title` headings
  - **Preserve document lists** in `.action-card` containers (these are interactive)
- [ ] **Step 4: Update JS** — update `updateStepper()` to use new tab class names. Add `updateProgressFill()`. Update eyebrow. The `renderDocList()` function mostly stays the same but adjust any class references.
- [ ] **Step 5: Update cache busters** to `?v=20260424b`
- [ ] **Step 6: Test** — verify 2-step stepper renders, document lists display, case summary info rows work
- [ ] **Step 7: Commit**

```bash
git add pages/pbs.html
git commit -m "feat: redesign PBS & Medicare page with dark header and minimal layout"
```

---

### Task 5: Rewrite commencement.html

**Files:**
- Modify: `pages/commencement.html` (lines 16-244 CSS, lines 246-372 HTML)

**Reference:** Use the design spec. Commencement has **no step tabs** — it uses a countdown + checklist + timeline pattern. The dark header will contain just the page header (no tabs, no eyebrow).

- [ ] **Step 1: Replace font imports** — same as Task 1 Step 1
- [ ] **Step 2: Replace CSS** — apply the design system variables and shared styles. Commencement-specific:
  - `.hero-compact` is simpler here — no tabs section, just header row
  - Keep `.countdown-card` but restyle: use `.action-card` styling (white card with border, this is an interactive display)
  - Replace `.card` wrappers around checklists with flat layout — checklist items flow directly on the surface
  - `.check-item` styling: clean row with checkbox, title, due date — use `.info-row`-like layout
  - `.timeline` styling: simplify with left-border connector, minimal dots
- [ ] **Step 3: Restructure HTML**:
  - Dark header: just page name "Commencement" + subtitle "Pre-arrival checklist" + icons. No tabs.
  - Content area: countdown card (kept as `.action-card`), flat checklist items, timeline
  - Convert `.card.pre-arrival` and `.card.first-day` wrappers — remove the card containers, use section headings (`.sec-title`) + flat checklist items
- [ ] **Step 4: Update JS** — no tab logic to change. Preserve `updateProgress()`, `syncCheckItems()`, `updateCountdown()`, `renderTimeline()`. Only update any class name references if changed.
- [ ] **Step 5: Update cache busters** to `?v=20260424b`
- [ ] **Step 6: Test** — verify countdown renders, checklists toggle, timeline displays, due dates calculate
- [ ] **Step 7: Commit**

```bash
git add pages/commencement.html
git commit -m "feat: redesign commencement page with dark header and minimal layout"
```

---

### Task 6: Rewrite registration-intro.html

**Files:**
- Modify: `pages/registration-intro.html` (lines 15-244 CSS, lines 246-263 HTML)

**Reference:** Use the design spec section "Registration Intro Page". This page is currently a full-screen image background — we're bringing it into the app design language.

- [ ] **Step 1: Replace font imports** — same as Task 1 Step 1
- [ ] **Step 2: Replace CSS** — full rewrite:
  - Remove the background image (`gp link reg app bg.png`) and dark theme variables
  - Add design system variables (same as other pages)
  - `.hero-compact` — simpler version, just header row, no tabs or eyebrow
  - `.reg-intro-content` — centered content area on light surface:
    ```css
    .reg-intro-content {
      background: var(--surface);
      min-height: calc(100dvh - 120px);
      display: grid;
      place-items: center;
      padding: 0 20px 40px;
    }
    .reg-intro-inner {
      text-align: center;
      max-width: 400px;
    }
    ```
  - `.reg-intro-title` — Source Serif 4, larger: `font-size: clamp(2rem, 8vw, 3rem); font-weight: 700; color: var(--ink)`
  - `.reg-intro-lead` — `font-size: 1.1rem; color: var(--ink-muted); line-height: 1.4`
  - `.start-btn` — restyle as `.btn-primary` but larger: `padding: 16px 28px; font-size: 15px; width: 100%; max-width: 300px`
  - Remove `@keyframes scanPulse` animation (not needed in new design — the button doesn't pulse)
  - `.reg-intro-note` — small muted text below button
- [ ] **Step 3: Restructure HTML**:
  - Replace the full-screen `.intro-shell` / `.intro-card` structure with:
    ```html
    <body>
      <div class="hero-compact">
        <div class="hero-compact-pad">
          <div class="hero-header">
            <div class="hero-left">
              <div class="hero-avatar" id="headerAvatar">KM</div>
              <div>
                <div class="hero-name" id="heroName">Welcome</div>
                <div class="hero-sub-text">Registration pathway</div>
              </div>
            </div>
            <div class="hero-icons">
              <!-- bell + settings -->
            </div>
          </div>
        </div>
      </div>
      <div class="reg-intro-content">
        <div class="reg-intro-inner">
          <h1 class="reg-intro-title">Your Registration Pathway</h1>
          <p class="reg-intro-lead">Complete each step to begin practising in Australia</p>
          <div class="reg-intro-actions">
            <button class="start-btn" id="startBtn">Begin Registration →</button>
          </div>
          <p class="reg-intro-note">Already started? Your progress is saved automatically.</p>
        </div>
      </div>
    </body>
    ```
  - The JS for `navigateToRegistration()` and `markSeenAndContinue()` stays the same
- [ ] **Step 4: Update JS** — preserve navigation logic. Update avatar initialization if it reads user data. Remove any animation-related JS if present.
- [ ] **Step 5: Update cache busters** to `?v=20260424b`
- [ ] **Step 6: Test** — verify intro page renders with dark header and centered content, button navigates to myinthealth, mobile layout works
- [ ] **Step 7: Commit**

```bash
git add pages/registration-intro.html
git commit -m "feat: redesign registration intro page with dark header and light content"
```

---

### Task 7: Update registration-stepper.js styles

**Files:**
- Modify: `js/registration-stepper.js` (lines 6-390 — the `ensureStyles()` function)

**Reference:** This component injects its own CSS into the page. Its styles need to match the new design system.

- [ ] **Step 1: Read the current file** to understand the full injected CSS and how it interacts with page styles.
- [ ] **Step 2: Update the injected CSS** inside `ensureStyles()`:
  - Replace color values to use the new palette (e.g., `#7c3aed` purple → `var(--accent)` blue, `#2563eb` → `var(--accent)`)
  - Replace font references from Inter to DM Sans
  - Update `.registration-stepper-circle` styles: active uses `var(--accent)`, completed uses `var(--success)`
  - Update progress line: use `var(--success)` green, `2px` height
  - Update hover/focus states to match new design language
  - Update the responsive breakpoint styles at line 352
- [ ] **Step 3: Update `syncProgressLine()`** (line 460): modify to calculate width stopping at the left edge of the current step element (not through it), matching the new spec behavior
- [ ] **Step 4: Update cache buster** on any page that imports this file: check all 6 registration pages for `registration-stepper.js` imports and update to `?v=20260424b`
- [ ] **Step 5: Test** — verify the stepper component renders correctly on any page that uses it
- [ ] **Step 6: Commit**

```bash
git add js/registration-stepper.js
git commit -m "feat: update registration stepper component styles for new design system"
```

---

### Task 8: Final integration test + push

**Files:**
- All 6 pages + `js/registration-stepper.js`

- [ ] **Step 1: Run the dev server** with `npm start`
- [ ] **Step 2: Test each page in standalone mode** (direct URL):
  - `/pages/registration-intro.html` — dark header, centered content, button works
  - `/pages/myinthealth.html` — dark header, tabs, progress line, info rows, tutorial toggle
  - `/pages/amc.html` — same pattern, AMC-specific content
  - `/pages/ahpra.html` — placement gate still works, registration steps render after gate
  - `/pages/pbs.html` — 2-step tabs, document lists, case summary
  - `/pages/commencement.html` — countdown, checklists, timeline
- [ ] **Step 3: Test inside app shell** — navigate to `/pages/app-shell.html` and:
  - Open each registration page via the registration dropdown
  - Verify the dark header doesn't clash with the app shell topbar
  - Verify mobile bottom nav clearance (100px padding)
  - Verify the `nav-shell-bridge.js` still hides the in-page header when embedded (the `.hero-compact` should get hidden by the bridge's `gp-shell-embedded` class — if not, add CSS: `.gp-shell-embedded .hero-compact .hero-header { display: none; }`)
- [ ] **Step 4: Test mobile** — resize browser to <860px:
  - Dark header sticks on scroll
  - Tabs scroll horizontally
  - Buttons stack full-width
  - Touch targets are 44px minimum
- [ ] **Step 5: Push to remote**

```bash
git push origin main
```
