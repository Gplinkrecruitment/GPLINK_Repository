# Desktop Sidebar Layout — Implementation Plan

Spec: `docs/superpowers/specs/2026-04-26-desktop-sidebar-layout-design.md`

## Task 1: Full-width nav in app-shell.html
**File:** `pages/app-shell.html`
- Remove `max-width: 960px` from `.app-shell-desktop-inner` (line ~62)
- Add horizontal padding to compensate: `padding: 0 32px`

## Task 2: Full-width + sidebar on myinthealth.html (reference implementation)
**File:** `pages/myinthealth.html`
This is the first page — get the pattern right here, then replicate to others.

### CSS changes (desktop media query, 861px+):
- Hide `.hero-compact` on desktop: `display: none`
- Remove `max-width: 960px` from `.dash-wrap`
- Add `.desktop-sidebar` styles: 260px wide, fixed position, top below nav (~90px), bottom 0, dark gradient bg, overflow-y auto, z-index 100
- Add `.desktop-sidebar` step items, connector lines, progress bar, help link styles
- Add `margin-left: 260px` to `.reg-content` on desktop
- Remove max-width constraint from `.reg-content` on desktop

### HTML changes:
- Add `<aside class="desktop-sidebar" id="desktopSidebar"></aside>` before the hero section

### JS changes:
- Add `renderDesktopSidebar()` function that:
  - Reads the existing step metadata (same data used by tab rendering)
  - Renders sidebar HTML: page title, steps with done/active/pending states, connector lines, progress bar
  - Makes completed steps clickable (navigates to that substep)
  - Calls this function from the existing `renderCurrentStep()` or equivalent init flow
- Wire up step click handlers to navigate between substeps (same as existing tab click logic)

## Task 3: Replicate sidebar to amc.html
**File:** `pages/amc.html`
- Same CSS pattern as myinthealth.html (sidebar styles in desktop media query)
- Same HTML sidebar element
- Same JS `renderDesktopSidebar()` — adapted for AMC's 4 steps (create_portfolio, upload_credentials, qualifications_pending, qualifications_verified)
- Hide `.hero-compact` on desktop
- Remove `max-width` from `.dash-wrap` and `.reg-content`

## Task 4: Replicate sidebar to ahpra.html
**File:** `pages/ahpra.html`
- Same pattern — adapted for AHPRA's step structure
- Hide hero, remove max-width, add sidebar

## Task 5: Replicate sidebar to pbs.html and commencement.html
**Files:** `pages/pbs.html`, `pages/commencement.html`
- Same pattern for both pages
- These pages have simpler step structures

## Task 6: Full-width on non-sidebar pages
**Files:** `pages/index.html`, `pages/account.html`, `pages/career.html`, `pages/registration-intro.html`
- Remove `max-width: 960px` from `.dash-wrap` on desktop
- No sidebar needed — just full-width content
- Ensure content still looks good at full width (may need max-width on text content for readability)

## Task 7: Verify and fix
- Test all pages at various desktop widths (861px, 1200px, 1920px)
- Verify mobile is untouched (860px and below)
- Verify bypass account navigation works with sidebar
- Check app-shell iframe embedding still works
