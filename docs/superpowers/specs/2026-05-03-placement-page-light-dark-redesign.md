# Placement Page Light/Dark Mode Redesign

**Date:** 2026-05-03
**File:** `pages/career.html` (secured view — `body.career-mode-secured`)

## Summary

Redesign the secured placement view to work properly in both light and dark modes. Currently the page uses hardcoded dark colors everywhere. The redesign introduces a proper light mode as the default, with dark mode using CSS variables, and an inverted hero card strategy (dark hero on light page, frosted hero on dark page).

## Design Decisions

| Decision | Choice |
|----------|--------|
| Hero card (light mode) | Dark gradient accent (`#0f172a → #1e293b`) on white page |
| Hero card (dark mode) | Frosted translucent glass (`rgba(255,255,255,0.08)` + `backdrop-filter: blur(20px)`) on dark page |
| Surrounding cards | CSS variables — `var(--panel)`, `var(--text)`, `var(--line)`, `var(--muted)` |
| Practice contact buttons | 3-column grid: Call, Email, WhatsApp |
| Broker card | Full card with bio, Email + WhatsApp only (no Call) |
| Area Guide | Hidden (`display: none`) for MVP |
| Lifestyle module | Already hidden, stays hidden |

## Component Specs

### 1. Page Background

```
Light: var(--bg) = #ffffff
Dark:  var(--bg) = #080c1a
```

Body atmospheric gradients already adapt via `html.dark-mode body::before`.

### 2. Hero Card (`placement-hero-card`)

**Light mode** (default — inside `body.career-mode-secured`):
- `background: radial-gradient(360px 180px at 100% 0%, rgba(37,99,235,0.10), transparent 62%), linear-gradient(180deg, #0f172a 0%, #1e293b 100%)`
- `border: 1px solid rgba(255,255,255,0.06)`
- `box-shadow: 0 28px 40px -34px rgba(15,23,42,0.6)`
- All text white, kicker `#60a5fa`, muted text `rgba(226,232,240,0.68)`

**Dark mode** (inside `html.dark-mode body.career-mode-secured`):
- `background: rgba(255,255,255,0.08)`
- `backdrop-filter: blur(20px)`
- `border: 1px solid rgba(255,255,255,0.12)`
- `box-shadow: none` or very subtle
- Text: `#f1f5f9` primary, `rgba(148,163,184,0.8)` muted

**Stat cards** (inside hero):
- Both modes: `background: rgba(255,255,255,0.06)`, `border: 1px solid rgba(255,255,255,0.10)`
- Light mode values: `#fff`
- Dark mode values: `#e2e8f0`

### 3. Income Strip (`placement-income-float`)

- `background: var(--panel)`, `border: 1px solid var(--line)`
- Value: `color: var(--text)`
- Label/unit: `color: var(--muted)`

### 4. Practice Contact Card (`placement-practice-contact-card`)

- `background: var(--panel)`, `border: 1px solid var(--line)`
- Kicker: `var(--muted)`, name: `var(--text)`, role: `var(--muted)`
- Avatar: keeps gradient (`#4338ca → #2563eb`)

**Contact buttons** (`placement-practice-contact-actions`):
- Grid: `repeat(3, minmax(0, 1fr))`
- Default: `background: var(--panel-soft)`, `border: 1px solid var(--line)`, `color: var(--text)`
- WhatsApp: `color: #16a34a` (light) / `color: #22c55e` (dark), green-tinted border
- Hover: `border-color: var(--blue)`, `background: rgba(37,99,235,0.06)`

### 5. Checklist (`placement-checklist`)

- Uses `var(--text)` for title and item labels
- Check circles: completed = `background: #2563eb; color: #fff`, current = `border: 1.5px solid #2563eb` + pulse animation, pending = `border: 1.5px solid var(--line-strong)`
- Already uses CSS variables — minimal changes needed

### 6. Broker Card (`placement-broker-card`)

Currently hidden via `display: none` in secured mode. Changes:
- **Un-hide**: remove `display: none` override
- `background: var(--panel)`, `border: 1px solid var(--line)`
- Text colors: `var(--text)` for name, `var(--muted)` for role/note
- Presence badge: light = `rgba(37,99,235,0.08)` bg / `#1d4ed8` text; dark = `rgba(96,165,250,0.12)` bg / `#60a5fa` text
- **Actions grid**: Change from 3 columns to 2 columns (Email + WhatsApp only)
- Remove the Call `<a>` element from the broker actions HTML
- WhatsApp button: solid `#16a34a` background, white text

### 7. Dock Card (`placement-dock-card`)

- `background: var(--panel)`, `border: 1px solid var(--line)`, `box-shadow: var(--shadow-card)`
- Text: `var(--text)` for name, `var(--muted)` for role
- Buttons: `var(--panel-soft)` bg, `var(--line)` border, `var(--text)` color
- WhatsApp: `#16a34a` bg, `#16a34a` border, `#fff` color

### 8. Hidden Elements

- `.area-guide-link`: `display: none`
- `.practice-lifestyle-module`: already `display: none` inline

## Implementation Approach

All changes are CSS-only in `pages/career.html` `<style>` block, plus:
1. Remove the Call `<a>` from broker actions HTML
2. Un-hide the broker card in secured mode
3. Add `html.dark-mode body.career-mode-secured` overrides for the hero card frosted glass effect
4. Ensure all `body.career-mode-secured` styles use CSS variables instead of hardcoded colors

**No new files.** No JS changes. Pure CSS + minor HTML edits.

## Dark Mode Override Structure

```css
/* Hero card frosted glass in dark mode */
html.dark-mode body.career-mode-secured .placement-hero-card {
  background: rgba(255,255,255,0.08);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.12);
  box-shadow: none;
}

/* Stat card text adapts */
html.dark-mode body.career-mode-secured .placement-stat-value {
  color: #e2e8f0;
}

/* All other cards inherit from var(--panel) etc. — no explicit dark overrides needed */
```

## What's NOT Changing

- Hero card content structure (kicker, title, subtitle, countdown, stats)
- Practice contact card HTML structure (just CSS)
- Checklist structure and JS logic
- Income strip layout
- Mobile/desktop responsive breakpoints (480px / 720px grid)
- App shell integration
- Any JS behaviour
