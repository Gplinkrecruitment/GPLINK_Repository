# Registration Pages UI Redesign

**Date:** 2026-04-24
**Status:** Design approved
**Scope:** All 6 registration step pages + their sub-steps

## Overview

Retouch all registration step pages to match the app's dashboard design language. Replace the current card-heavy, pill-laden layout with a clean, professional interface using a compact dark header, serif/sans typography pairing, and minimal content structure. Target audience is international GPs — the UI must feel institutional and trustworthy, not trendy or AI-generated.

## Pages In Scope

1. `pages/registration-intro.html` — entry point
2. `pages/myinthealth.html` — MyIntealth (health insurance)
3. `pages/amc.html` — AMC Portfolio
4. `pages/ahpra.html` — AHPRA Registration
5. `pages/pbs.html` — PBS & Medicare
6. `pages/commencement.html` — Commencement

## Design Decisions

### Typography

Replace Inter with a serif + sans pairing:

- **Headings:** Source Serif 4 (weight 600) — precise, institutional
- **Body:** DM Sans (weights 400–700) — clean, readable, distinctive
- Google Fonts import: `Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700` and `DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700`

### Color Palette

Refined tones, not stock Tailwind:

```css
--ink: #0c1222;          /* primary text, dark surfaces */
--ink-soft: #3d4663;     /* secondary text */
--ink-muted: #7c849b;    /* tertiary text, labels */
--surface: #f2f4f8;      /* page background */
--surface-raised: #ffffff; /* cards when needed */
--border: #e4e7ee;       /* card borders */
--border-light: #eef0f4; /* dividers, info row separators */
--accent: #1a56db;       /* links, active tab indicators */
--accent-glow: rgba(26, 86, 219, 0.12); /* active nav bg */
--success: #0d7c5f;      /* done states */
--warn-border: #e5a630;  /* warning left-border accent */
--warn-text: #8a6316;    /* warning text */
--hero-from: #0c1222;    /* dark header gradient start */
--hero-to: #162036;      /* dark header gradient end */
```

### Spacing

4px grid system. Every margin/padding/gap is a multiple of 4px:

```css
--sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
--sp-5: 20px; --sp-6: 24px; --sp-7: 28px; --sp-8: 32px;
--sp-10: 40px; --sp-12: 48px;
```

## Layout Structure

### Vertical Stack (all 5 step pages)

```
┌───────────────────────────────────────┐
│  COMPACT DARK HEADER                  │
│  ┌───────────────────────────────────┐│
│  │ [Avatar] Page Title     [🔔] [⚙️]││
│  │          Subtitle                 ││
│  │                                   ││
│  │ STEP 2 OF 4                       ││
│  │ ● ─── ● ─── ○ ─── ○             ││
│  │ [Tab1] [Tab2] [Tab3] [Tab4]      ││
│  └────── border-radius: 0 0 20 20 ──┘│
├───────────────────────────────────────┤
│  LIGHT SURFACE (#f2f4f8)              │
│                                       │
│  Choose Your Plan  (Source Serif 4)   │
│  Description text  (DM Sans, muted)  │
│                                       │
│  ● Watch: Tutorial link (2 min)       │
│    ┌─ collapsible video embed ──┐     │
│    │  <video> inline            │     │
│    └────────────────────────────┘     │
│                                       │
│  ⚠ Warning left-border accent        │
│                                       │
│  Section Title                        │
│  Label ..................... Value     │
│  Label ..................... Value     │
│  Label ..................... Value     │
│  ─────────────────────────────────    │
│                                       │
│  [← Back]              [Continue →]   │
└───────────────────────────────────────┘
```

### Registration Intro Page

Currently has a full-screen image background disconnected from the app. Bring into the same language:

```
┌───────────────────────────────────────┐
│  COMPACT DARK HEADER                  │
│  ┌───────────────────────────────────┐│
│  │ [Avatar] GP Link        [🔔] [⚙️]││
│  │          Registration pathway     ││
│  │  (uses user avatar + name like    ││
│  │   the step pages, not "GP Link")  ││
│  └────── border-radius: 0 0 20 20 ──┘│
├───────────────────────────────────────┤
│  LIGHT SURFACE                        │
│                                       │
│  (centered content)                   │
│                                       │
│  Your Registration                    │
│  Pathway     (Source Serif 4, large)  │
│                                       │
│  Complete each step to begin          │
│  practising in Australia              │
│                                       │
│  [Begin Registration →]              │
│                                       │
│  Already started? Your progress       │
│  is saved automatically.             │
│                                       │
└───────────────────────────────────────┘
```

## Component Specifications

### 1. Compact Dark Header

```css
.hero-compact {
  background: linear-gradient(170deg, var(--hero-from), var(--hero-to));
  border-radius: 0 0 20px 20px;
  overflow: hidden;
  position: relative;
}
/* Subtle noise texture overlay for depth */
.hero-compact::before {
  content: "";
  position: absolute; inset: 0;
  background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  background-size: 200px;
  opacity: 0.5;
  pointer-events: none;
}
```

- **Contains:** header row, step eyebrow, progress connector, step tabs
- **Desktop padding:** 20px 28px 16px
- **Mobile padding:** 16px 20px 12px
- **Bottom radius:** 20px — smooth transition to light surface
- **Sticky on mobile scroll:** `position: sticky; top: 0; z-index: 100;`

### 2. Header Row

- Avatar: 40px desktop, 34px mobile. Gradient `linear-gradient(140deg, #3366cc, #5588dd)`.
- Page name: DM Sans 15px/700 (desktop), 14px (mobile), white.
- Subtitle: DM Sans 12px/400 (desktop), 11px (mobile), `rgba(255,255,255,0.35)`.
- Icon buttons: 36px visible size on both desktop and mobile. On mobile, extend the tap area to 44px minimum via `padding: 4px` on a wrapping element or `min-width: 44px; min-height: 44px` on the button itself with the icon centered. Background `rgba(255,255,255,0.06)`, border `rgba(255,255,255,0.08)`.

### 3. Step Eyebrow

```css
.step-eyebrow {
  font-family: var(--font-body);
  font-size: 11px; /* 10px mobile */
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(255,255,255,0.3);
}
```

### 4. Progress Connector Line

A single green line connecting completed steps only. No gray track for future steps — the line ends at the right edge of the active tab's glass box.

```css
.tabs-track {
  position: relative;
}
/* Green line — connects completed steps, ends at active tab edge */
.tabs-progress-fill {
  position: absolute;
  top: 50%;
  left: 0;
  height: 2px;
  background: var(--success);
  transform: translateY(-50%);
  transition: width 0.4s ease;
  z-index: 0;
  border-radius: 1px;
}
.tabs {
  position: relative;
  z-index: 1;
}
```

Width is calculated by JS to reach the **left edge** of the active (current) tab element: `activeTab.offsetLeft`. The green line stops where the active tab's glass box begins — it does not enter or pass through the glass box. The existing step-state JS in each page already tracks which steps are done — wire the fill width to that measurement. No line appears beyond the last completed tab.

### 5. Step Tabs

```css
.tab {
  padding: 8px 14px; /* 7px 10px mobile */
  border-radius: 8px;
  font-size: 12px; /* 11px mobile */
  font-weight: 500;
  color: rgba(255,255,255,0.35);
  border: 1px solid transparent;
}
.tab.active {
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.1);
  color: #fff;
  font-weight: 600;
}
.tab-n {
  width: 20px; height: 20px; /* 18px mobile */
  border-radius: 50%;
  font-size: 10px;
  background: rgba(255,255,255,0.08);
}
.tab.active .tab-n { background: var(--accent); color: #fff; }
.tab.done .tab-n { background: var(--success); color: #fff; }
```

### 6. Step Title (on light surface)

```css
.step-title {
  font-family: var(--font-heading);
  font-size: 28px; /* 23px mobile */
  font-weight: 600;
  color: var(--ink);
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin-bottom: var(--sp-2);
}
```

### 7. Tutorial Link (collapsible video)

Inline text link that expands to show the video embed in-place:

```html
<button class="tut-toggle">
  <span class="tut-dot"></span>
  Watch: How to choose the right plan (2 min)
  <span class="tut-caret">▾</span>
</button>
<div class="tut-video-wrap" hidden>
  <video class="tut-video" controls>...</video>
</div>
```

- Collapsed: accent-colored text link with 6px dot indicator
- Expanded: video element slides down with `max-height` transition
- No card container — just the video with `border-radius: 12px`

### 8. Warning Alerts

Left-border accent only — no background fill, no card:

```css
.warn {
  border-left: 2px solid var(--warn-border);
  padding: 12px 0 12px 16px;
}
.warn-title { font-size: 13px; font-weight: 600; color: var(--warn-text); }
.warn-text { font-size: 12px; color: var(--warn-text); opacity: 0.8; }
```

### 9. Info Rows

Label:value pairs with thin dividers — no boxed containers:

```css
.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 0; /* 12px mobile */
  border-bottom: 1px solid var(--border-light);
}
.info-label { font-size: 14px; font-weight: 400; color: var(--ink-muted); }
.info-val { font-size: 14px; font-weight: 600; color: var(--ink); }
```

### 10. Buttons

```css
/* Primary: dark ink, not blue */
.btn-primary {
  padding: 12px 24px;
  border-radius: 10px;
  background: var(--ink);
  color: #fff;
  font-size: 13px; font-weight: 600;
  box-shadow: 0 1px 3px rgba(12,18,34,0.2);
}
.btn-primary:hover {
  background: #1a2540;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(12,18,34,0.2);
}

/* Back: ghost text, no border */
.btn-ghost {
  padding: 12px 20px;
  background: transparent;
  color: var(--ink-muted);
  font-size: 13px; font-weight: 500;
}
.btn-ghost:hover { color: var(--ink); }

/* Mobile: buttons stack full-width, primary on top */
```

### 11. Action Cards (only where needed)

Used ONLY for grouped interactive elements like document uploads, form inputs, or file drag-and-drop zones:

```css
.action-card {
  background: var(--surface-raised);
  border-radius: 12px;
  border: 1px solid var(--border);
  padding: 20px;
}
```

NOT used for displaying information — that's handled by info rows and typography.

## Responsive Behavior

### Breakpoint: 860px (matches app shell)

**Desktop (≥860px):**
- App shell topbar visible, page loads in iframe
- Dark header: `padding: 20px 28px 16px`
- Content max-width: `960px`
- Buttons side-by-side
- Info rows: `14px` font

**Mobile (<860px):**
- App shell mobile bottom nav visible
- Dark header: sticky on scroll, `padding: 16px 20px 12px`
- Tabs: horizontally scrollable
- Icon buttons: 36px with 44px touch target (padding extends tap area)
- Buttons: stack vertically, full-width, primary on top
- Info rows: `13px` font
- Content bottom padding: `100px` (clears bottom nav)

## Elements Removed

These elements from the current design are intentionally removed:

1. **Colored top stripes** on cards (`::before` gradient bars) — visual noise
2. **Status badge pills** (`step-content-badge`) — the step eyebrow and tab state cover this
3. **Card wrappers around info grids** — info rows with dividers replace these
4. **Tutorial video cards** — replaced with collapsible inline link
5. **Nested card-in-card patterns** — content flows on the surface directly
6. **Inter font** — replaced with Source Serif 4 + DM Sans
7. **Stock Tailwind colors** — replaced with refined palette

## Elements Preserved

1. **In-page header** (avatar + greeting) — needed for direct page access
2. **Step tab navigation** with numbered circles
3. **Warning/alert boxes** — simplified to left-border accent
4. **Info grid data** — restructured as label:value rows
5. **Action buttons** (Continue/Back) — restyled
6. **Bottom padding clearance** for mobile nav
7. **JS behavior** — tab switching, step state management, scroll-to-active

## Migration Notes

- Each page has ~300+ lines of inline `<style>`. The CSS will be rewritten in-place.
- HTML structure changes: remove `.step-content` card wrappers, add `.hero-compact` section, restructure info grids to rows.
- The `js/registration-stepper.js` component will need its CSS updated to match the new tab styles.
- Font imports change from Inter to Source Serif 4 + DM Sans on all 6 pages.
- The app shell (`pages/app-shell.html`) is NOT modified — only the iframed pages change.
- Cache buster version: `?v=20260424b` on all modified script/style references.
