# Career Page Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 3 new standalone career pages (interview-prep, offer-review, area-guide) and wire navigation from existing pages so every user interaction leads to a functional page.

**Architecture:** Each new page is a standalone HTML file in `/pages/` with inline `<style>` and `<script>`, matching the existing pattern. Pages load standard JS dependencies (auth-guard, nav-shell-bridge, etc.), accept query params for context, and render with demo data. Real data connections are deferred to Phase 2.

**Tech Stack:** Vanilla HTML/CSS/JS, Inter font (Google Fonts), CSS custom properties for dark/light theming, localStorage for state persistence.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `pages/interview-prep.html` | Interview strategy coaching page |
| Create | `pages/offer-review.html` | Offer review and acceptance page |
| Create | `pages/area-guide.html` | Relocation area guide with tabs |
| Modify | `pages/application-detail.html` | Add interview strategy link + offer card |
| Modify | `pages/career.html` | Add navigation links for interview/offer/area guide |

---

### Task 1: Create `pages/interview-prep.html`

Convert the approved mockup (`.superpowers/brainstorm/7582-1775748515/content/interview-prep-v8-final.html`) into a production page with standard script loading, query param handling, and shell integration.

**Files:**
- Create: `pages/interview-prep.html`
- Reference: `.superpowers/brainstorm/7582-1775748515/content/interview-prep-v8-final.html`
- Reference: `pages/application-detail.html` (for script tags, dark mode, shell patterns)

- [ ] **Step 1: Read the approved mockup and application-detail.html for patterns**

Read both files to understand the full mockup content and the production patterns used in existing pages:
- Script tags and cache buster format from application-detail.html lines 10-17
- Dark mode class pattern from application-detail.html lines 305-330
- Shell navigation pattern from application-detail.html lines 334-338

- [ ] **Step 2: Create the page with standard head and script tags**

Create `pages/interview-prep.html`. Start with the `<head>` section matching existing pages:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Interview Strategy — GP Link</title>
<script src="../js/native-bridge.js?v=20260410a"></script>
<script src="../js/nav-shell-bridge.js?v=20260410a" defer></script>
<script src="../js/auth-guard.js?v=20260410a" defer></script>
<script src="../js/state-sync.js?v=20260410a" defer></script>
<script src="../js/updates-sync.js?v=20260410a" defer></script>
<script src="../js/qualification-camera.js?v=20260410a" defer></script>
<script src="../js/qualification-scan.js?v=20260410a" defer></script>
<script src="../js/account-dropdown.js?v=20260410a" defer></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
```

- [ ] **Step 3: Add the full CSS from the mockup**

Copy the complete `<style>` block from `interview-prep-v8-final.html` (lines 10-423). This includes:
- All CSS custom properties (light mode defaults in `:root`, dark overrides in `@media (prefers-color-scheme: dark)`)
- All component styles: back-bar, hero, countdown, action-row, glass-section, strategy items, person rows, bullet items, question items, officer, post-interview state, animations

Also add a `html.dark-mode` override block after the `@media` block so the page respects the app's JS-controlled dark mode toggle (existing pages use `html.dark-mode` class):

```css
html.dark-mode {
  /* Same overrides as the @media (prefers-color-scheme: dark) block */
  --bg: #0b1120;
  --surface-glass: rgba(255, 255, 255, 0.03);
  /* ... all dark mode vars ... */
}
```

- [ ] **Step 4: Add the HTML body from the mockup**

Copy the complete `<body>` content from `interview-prep-v8-final.html` (lines 425-687). This includes:
- Back bar with back button
- Pre-interview state: hero, countdown, action row, who you're meeting, strategy glass section, what they're looking for, what to emphasise, mistakes to avoid, questions to ask, guidance officer
- Post-interview state: "How did it go?" feedback card
- Copy toast element
- All inline JavaScript (countdown timer, notes persistence, tap-to-copy)

- [ ] **Step 5: Update the back button for shell navigation**

Replace the static back button with the shell-aware navigation pattern used in application-detail.html:

```html
<div class="back-bar">
  <a href="application-detail.html" class="back-btn" id="backBtn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
    Back
  </a>
  <span class="back-title">Interview Strategy</span>
</div>
```

Add JS at the bottom of the inline script to handle back navigation:

```javascript
// Back navigation
document.getElementById('backBtn').addEventListener('click', function(e) {
  e.preventDefault();
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = 'career.html#applications';
  }
});
```

- [ ] **Step 6: Add query param handling with demo data fallback**

Add at the top of the inline `<script>` block, before the countdown logic:

```javascript
(function() {
  var params = new URLSearchParams(window.location.search);
  var applicationId = params.get('id') || params.get('applicationId') || '';

  // Phase 2: fetch real data from /api/career/application?id=applicationId
  // For now, page renders with demo data from the mockup.
  // When wired, replace static text with fetched values:
  //   - practice name, address from application.practice_name, application.practice_address
  //   - interview date/time from application.interview.scheduled_at
  //   - zoom link from application.interview.zoom_join_url
  //   - interviewer from application.interview.interviewer_name
})();
```

- [ ] **Step 7: Remove the design label**

Delete the design label element from the bottom of the page (it's a mockup artifact):

```html
<!-- DELETE THIS LINE -->
<div class="design-label">Interview Strategy — GP Link — Final</div>
```

- [ ] **Step 8: Verify the page renders**

Run: `npm start` (if not already running)
Open: `http://localhost:3000/pages/interview-prep.html`

Expected: Page renders with demo data, countdown ticks, notes save to localStorage, tap-to-copy works, dark/light mode responds to system preference.

- [ ] **Step 9: Commit**

```bash
git add pages/interview-prep.html
git commit -m "Add interview strategy page with demo data

Standalone page for personalised interview coaching. Includes live
countdown, tap-to-copy questions, personal notes, post-interview
feedback state. Demo data for now — real data connection in Phase 2."
```

---

### Task 2: Create `pages/offer-review.html`

Convert the offer review mockup into a production page.

**Files:**
- Create: `pages/offer-review.html`
- Reference: `.superpowers/brainstorm/7582-1775748515/content/offer-review.html`
- Reference: `pages/interview-prep.html` (for the patterns established in Task 1)

- [ ] **Step 1: Read the mockup**

Read `.superpowers/brainstorm/7582-1775748515/content/offer-review.html` for the full content.

- [ ] **Step 2: Create the page with standard head**

Create `pages/offer-review.html` with the same head pattern as Task 1 Step 2. Change the title to `Offer Review — GP Link`.

- [ ] **Step 3: Add the full CSS from the mockup**

Copy the complete `<style>` block from the offer-review mockup. Add the `html.dark-mode` override block (same as Task 1 Step 3) so JS-controlled dark mode works.

- [ ] **Step 4: Add the HTML body from the mockup**

Copy the full `<body>` content from the offer-review mockup. This includes:
- Back bar
- Pre-accept state: offer status badge, practice hero, deadline countdown, offer summary stats, "What GP Link Secured" glass section, contract highlights, decision CTAs, guidance officer
- Post-accept state: "Placement Secured" celebration with next steps
- Deadline countdown JS and `acceptOffer()` function

- [ ] **Step 5: Update back button for shell navigation**

Same pattern as Task 1 Step 5. Back link href to `application-detail.html`.

- [ ] **Step 6: Add query param handling**

```javascript
(function() {
  var params = new URLSearchParams(window.location.search);
  var applicationId = params.get('id') || params.get('applicationId') || '';

  // Phase 2: fetch offer data from /api/career/application?id=applicationId
  // Replace demo values with: offer terms, negotiation highlights,
  // contract details, response deadline.
})();
```

- [ ] **Step 7: Remove the design label**

Delete `<div class="design-label">Offer Review — GP Link — Design Mockup</div>`

- [ ] **Step 8: Verify the page renders**

Open: `http://localhost:3000/pages/offer-review.html`

Expected: Page renders with demo offer data, deadline countdown ticks, "Accept Offer" button triggers post-accept celebration state, dark/light mode works.

- [ ] **Step 9: Commit**

```bash
git add pages/offer-review.html
git commit -m "Add offer review page with demo data

Standalone page for reviewing and accepting practice offers. Shows
offer summary, negotiation highlights, contract terms, and accept/
request changes CTAs. Post-accept state shows placement secured
celebration. Demo data — real data connection in Phase 2."
```

---

### Task 3: Create `pages/area-guide.html`

Convert the area guide mockup into a production page.

**Files:**
- Create: `pages/area-guide.html`
- Reference: `.superpowers/brainstorm/7582-1775748515/content/area-guide.html`
- Reference: `pages/interview-prep.html` (for established patterns)

- [ ] **Step 1: Read the mockup**

Read `.superpowers/brainstorm/7582-1775748515/content/area-guide.html` for the full content.

- [ ] **Step 2: Create the page with standard head**

Same head pattern as Task 1. Title: `Area Guide — GP Link`.

- [ ] **Step 3: Add the full CSS from the mockup**

Copy the complete `<style>` block from the area-guide mockup. Add `html.dark-mode` override block.

- [ ] **Step 4: Add the HTML body from the mockup**

Copy the full `<body>` content. This includes:
- Back bar
- Hero with area name and meta tags
- 3-tab navigation (Overview, Living, Amenities)
- Overview tab: stats grid, climate cards, "Why GPs Like This Area" glass section
- Living tab: cost of living comparison, "Getting Around" glass section
- Amenities tab: nearby essentials, explore action tiles
- Guidance officer with WhatsApp CTA
- Tab switching JS

- [ ] **Step 5: Update back button and explore tile links**

Back button: same shell navigation pattern as Task 1 Step 5. Back link href to `career.html#secured`.

Update the explore tiles to link to the correct pages:
- "Housing Search" → `career.html#secured` (housing is embedded in career.html)
- "School Finder" → `career.html#secured` (schools are embedded in career.html)
- "Google Maps" → `https://maps.google.com/?q=Brighton+VIC+3186` (external, `target="_blank"`)
- "Council Website" → `#` (placeholder for now)

- [ ] **Step 6: Add query param handling**

```javascript
(function() {
  var params = new URLSearchParams(window.location.search);
  var applicationId = params.get('id') || params.get('applicationId') || '';
  var location = params.get('location') || '';

  // Phase 2: fetch area data based on practice location
  // Replace demo values with: real cost of living, amenities from
  // Google Places API, commute from Distance Matrix, climate lookup.
})();
```

- [ ] **Step 7: Remove the design label**

Delete `<div class="design-label">Area Guide — GP Link — Design Mockup</div>`

- [ ] **Step 8: Verify the page renders**

Open: `http://localhost:3000/pages/area-guide.html`

Expected: Page renders with Brighton demo data, tab switching works (Overview/Living/Amenities), climate cards display, cost comparisons show color-coded indicators, dark/light mode works.

- [ ] **Step 9: Commit**

```bash
git add pages/area-guide.html
git commit -m "Add area guide page with demo data

Standalone relocation guide with 3-tab layout: overview stats and
climate, cost of living comparisons, nearby amenities. Links to
housing search and school finder in career.html. Demo data — real
data connection in Phase 2."
```

---

### Task 4: Wire `pages/application-detail.html`

Add an "Interview Strategy" link from the interview card and an offer status card that links to the offer review page.

**Files:**
- Modify: `pages/application-detail.html`

- [ ] **Step 1: Read application-detail.html**

Read the full file to find exact insertion points. Key locations:
- Interview card HTML: lines 361-384
- Interview card JS rendering: lines 511-552
- Interview prep tips injection: lines 641-654
- Status timeline: lines 409-509

- [ ] **Step 2: Add "Interview Strategy" button to the interview card**

In the interview card JS rendering section (around line 552, after the interview metadata rows are rendered), add a button that links to the interview prep page. Find where the interview card buttons (Join Video Call, Add to Calendar) are populated and add after them:

```javascript
// After the existing Join Video Call and Add to Calendar buttons
var strategyLink = document.createElement('a');
strategyLink.href = 'interview-prep.html?id=' + encodeURIComponent(appId);
strategyLink.className = 'interview-strategy-btn';
strategyLink.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/><line x1="9" y1="22" x2="15" y2="22"/></svg> Interview Strategy';
```

Insert this button into the interview card's button container.

- [ ] **Step 3: Add CSS for the strategy button**

Add to the `<style>` block, near the existing interview card styles:

```css
.interview-strategy-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  border-radius: 10px;
  background: rgba(37, 99, 235, 0.06);
  border: 1px solid rgba(37, 99, 235, 0.1);
  color: var(--blue, #2563eb);
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  transition: background 0.14s;
  margin-top: 8px;
}
.interview-strategy-btn:hover {
  background: rgba(37, 99, 235, 0.1);
}
```

- [ ] **Step 4: Add offer card when status is "offer"**

Find where the interview card visibility is determined (around line 553). Add an offer card section that shows when the application status is an offer status. After the interview card rendering logic, add:

```javascript
// Show offer card if status is offer-related
var offerStatuses = ['offer', 'offer_pending', 'offered'];
if (offerStatuses.indexOf(app.status) !== -1) {
  var offerCard = document.getElementById('offerCard');
  if (offerCard) {
    offerCard.style.display = 'block';
    var offerLink = offerCard.querySelector('.offer-review-link');
    if (offerLink) {
      offerLink.href = 'offer-review.html?id=' + encodeURIComponent(appId);
    }
  }
}
```

Add the offer card HTML after the interview card (around line 384):

```html
<div class="offer-card" id="offerCard" style="display:none;">
  <div class="offer-card-header">
    <div class="offer-card-badge">Offer Received</div>
    <div class="offer-card-title">You have an offer from this practice</div>
  </div>
  <a href="#" class="offer-review-link offer-review-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><polyline points="20 6 9 17 4 12"/></svg>
    Review Offer
  </a>
</div>
```

- [ ] **Step 5: Add CSS for the offer card**

```css
.offer-card {
  margin-top: 16px;
  padding: 20px;
  border-radius: 14px;
  background: rgba(217, 119, 6, 0.06);
  border: 1px solid rgba(217, 119, 6, 0.12);
}
.offer-card-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 800;
  background: rgba(217, 119, 6, 0.1);
  color: #d97706;
  margin-bottom: 8px;
}
.offer-card-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 12px;
}
.offer-review-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  border-radius: 10px;
  background: #d97706;
  color: #fff;
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  transition: background 0.14s;
}
.offer-review-btn:hover { background: #b45309; }
```

Also add dark mode variants inside the existing `html.dark-mode` block.

- [ ] **Step 6: Replace static interview tips with strategy link**

Find the interview prep tips injection code (lines 641-654). Replace the static tips content with the strategy button. The existing static tips are less useful than the full strategy page.

Remove or comment out the static tips injection (lines 641-654) since the "Interview Strategy" button now provides a much more comprehensive resource.

- [ ] **Step 7: Verify changes**

Open: `http://localhost:3000/pages/application-detail.html?id=test`

Expected:
- Interview card shows "Interview Strategy" button linking to interview-prep.html
- If application status is "offer", offer card appears with "Review Offer" button
- All existing functionality still works (withdraw, view role, timeline)

- [ ] **Step 8: Commit**

```bash
git add pages/application-detail.html
git commit -m "Wire interview strategy and offer review links

Add Interview Strategy button to interview card, linking to the new
interview-prep.html page. Add offer card with Review Offer button
when application status is offer-related."
```

---

### Task 5: Wire `pages/career.html`

Add navigation links for interview strategy, offer review, and area guide from the career page.

**Files:**
- Modify: `pages/career.html`

- [ ] **Step 1: Read the relevant sections of career.html**

Read the application card rendering function (around lines 9600-9624), the application card click handler (lines 10070-10086), and the secured placement view (starting at line 5909).

- [ ] **Step 2: Add status-based action text on application cards**

Find the `renderApplications()` function (line 9600). In the application card template, the footer section (lines 9617-9620) has a conditional button. Enhance it to show contextual action text based on status:

Find the existing button rendering logic. Below the existing "View Application" or similar button, add a contextual action link for interview and offer statuses:

```javascript
// Inside the card template, after the existing footer button
var statusAction = '';
if (app.status === 'interview' || app.status === 'interview_scheduled') {
  statusAction = '<a href="interview-prep.html?id=' + encodeURIComponent(app.applicationId || app.id) + '" class="card-status-action card-status-interview" onclick="event.stopPropagation();">Interview Strategy →</a>';
} else if (app.status === 'offer' || app.status === 'offer_pending' || app.status === 'offered') {
  statusAction = '<a href="offer-review.html?id=' + encodeURIComponent(app.applicationId || app.id) + '" class="card-status-action card-status-offer" onclick="event.stopPropagation();">Review Offer →</a>';
}
```

Add this `statusAction` HTML into the card template output.

- [ ] **Step 3: Add CSS for card status action links**

Find the existing application card styles and add nearby:

```css
.card-status-action {
  display: block;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
  text-align: center;
  transition: background 0.14s;
}
.card-status-interview {
  background: rgba(37, 99, 235, 0.06);
  color: #2563eb;
  border: 1px solid rgba(37, 99, 235, 0.1);
}
.card-status-interview:hover { background: rgba(37, 99, 235, 0.1); }
.card-status-offer {
  background: rgba(217, 119, 6, 0.06);
  color: #d97706;
  border: 1px solid rgba(217, 119, 6, 0.1);
}
.card-status-offer:hover { background: rgba(217, 119, 6, 0.1); }
```

- [ ] **Step 4: Add Area Guide link in secured placement view**

Find the secured placement view section (starting at line 5909). Locate the "Life Around This Practice" heading area (line 5991). Add an "Area Guide" link near this section:

```html
<a href="area-guide.html" class="area-guide-link" id="areaGuideLink">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
  <div>
    <div style="font-weight:800;font-size:14px;">Area Guide</div>
    <div style="font-size:12px;color:var(--muted,#64748b);margin-top:2px;">Cost of living, commute, amenities</div>
  </div>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-left:auto;opacity:0.4;"><path d="m9 18 6-6-6-6"/></svg>
</a>
```

Add CSS for the link:

```css
.area-guide-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(37, 99, 235, 0.04);
  border: 1px solid rgba(37, 99, 235, 0.08);
  text-decoration: none;
  color: inherit;
  margin-bottom: 16px;
  transition: background 0.14s;
}
.area-guide-link:hover { background: rgba(37, 99, 235, 0.08); }
.area-guide-link svg:first-child { color: #2563eb; flex-shrink: 0; }
```

- [ ] **Step 5: Wire the Area Guide link with shell navigation**

Add click handler for the area guide link that uses the shell navigation pattern (same as existing application/role links at lines 10070-10104):

```javascript
document.addEventListener('click', function(e) {
  var areaLink = e.target.closest('#areaGuideLink');
  if (areaLink) {
    e.preventDefault();
    var route = '/pages/area-guide.html';
    if (window.parent && window.parent !== window && typeof window.parent.gpShellNavigate === 'function') {
      window.parent.gpShellNavigate(route, 'Area Guide');
    } else {
      window.location.href = 'area-guide.html';
    }
  }
});
```

- [ ] **Step 6: Verify changes**

Open: `http://localhost:3000/pages/career.html`

Expected:
- Application cards with interview status show "Interview Strategy →" link
- Application cards with offer status show "Review Offer →" link
- Clicking these links navigates to the correct new pages
- Secured placement view shows "Area Guide" link that navigates to area-guide.html

- [ ] **Step 7: Commit**

```bash
git add pages/career.html
git commit -m "Wire career page to interview, offer, and area guide pages

Add contextual action links on application cards for interview and
offer statuses. Add Area Guide link in secured placement view."
```

---

### Task 6: Final Verification and Polish

Verify all navigation flows work end-to-end and fix any issues.

**Files:**
- Possibly modify: any of the pages from Tasks 1-5

- [ ] **Step 1: Test the full interview flow**

1. Open `career.html` → find an application card → click to open `application-detail.html`
2. On application-detail, verify the interview card shows "Interview Strategy" button
3. Click "Interview Strategy" → verify `interview-prep.html` loads
4. On interview-prep, verify: countdown ticks, notes save, tap-to-copy works, back button returns to application-detail
5. If system is in dark mode, verify dark mode renders correctly on interview-prep

- [ ] **Step 2: Test the full offer flow**

1. On `application-detail.html`, verify offer card appears for offer-status applications
2. Click "Review Offer" → verify `offer-review.html` loads
3. On offer-review, verify: deadline countdown ticks, "Accept Offer" triggers celebration state, back button returns
4. Verify dark mode

- [ ] **Step 3: Test the area guide flow**

1. On `career.html`, navigate to the secured placement view
2. Verify "Area Guide" link appears in the Life Around This Practice section
3. Click it → verify `area-guide.html` loads
4. On area-guide, verify: tab switching works (Overview/Living/Amenities), all content displays, back button returns to career
5. Verify dark mode

- [ ] **Step 4: Test career.html card action links**

1. Verify "Interview Strategy →" appears on interview-status cards
2. Verify "Review Offer →" appears on offer-status cards
3. Click both → verify they navigate to the correct pages with the applicationId query param

- [ ] **Step 5: Fix any issues found**

Address any layout breaks, missing styles, broken links, or navigation failures discovered in Steps 1-4.

- [ ] **Step 6: Final commit (if fixes were needed)**

```bash
git add -A
git commit -m "Fix issues from end-to-end verification pass"
```
