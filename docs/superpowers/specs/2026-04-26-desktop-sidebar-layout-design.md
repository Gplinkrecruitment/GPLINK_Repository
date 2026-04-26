# Desktop Sidebar Layout Redesign

## Summary

Replace the current stacked layout (nav bar → dark hero → content, all constrained to 960px) with a full-width layout featuring a fixed left sidebar for step navigation on desktop. Mobile layout remains unchanged.

## Problem

On desktop, the current layout:
1. Constrains everything to 960px, leaving empty gutters on wide screens
2. Stacks nav bar, dark hero (with avatar, substep tabs), and content vertically — wasting vertical space before actual content begins
3. Duplicates identity (avatar in hero + account pill in nav)

## Design

### Layout Structure (desktop, 861px+)

```
+------------------------------------------------------------------+
|  [GP Link logo]          Home  Docs  Support  Practice  [Account]|  <- full-width nav
+------------------------------------------------------------------+
|            |                                                      |
| MyIntealth |  Upload Qualifications                               |
| __________ |  Upload your specialist qualification and nominate   |
|            |  AMC.                                                |
| [v] Accts  |                                                      |
|  |         |  + Watch walkthrough (2 min)                         |
| [v] Estab  |                                                      |
|  |         |  [Embedded Intealth Portal]                          |
| [3] Quals  |                                                      |
|  (active)  |                                                      |
|            |  [<- Back]              [Continue ->]                |
|            |                                                      |
| __________ |                                                      |
| Progress   |                                                      |
| [====  66%]|                                                      |
| Step 3/3   |                                                      |
|            |                                                      |
| Need help? |                                                      |
+------------+------------------------------------------------------+
  260px fixed          remaining width, scrollable
```

### Component Details

**Top Navigation Bar (app-shell.html)**
- Remove `max-width: 960px` from `.app-shell-desktop-inner`
- Nav spans full viewport width with horizontal padding (32px)
- All existing nav items, glassmorphism, and animations preserved

**Fixed Sidebar (registration step pages only)**
- Width: 260px, fixed position (stays while content scrolls)
- Background: `linear-gradient(180deg, #0c1222, #111827)`
- Top: page title + subtitle (e.g. "MyIntealth" / "EPIC Verification Process")
- Middle: vertical step list with:
  - Done steps: green circle with checkmark, muted title, "Completed" status
  - Active step: blue circle with number, white bold title, "In progress" status, highlighted background `rgba(255,255,255,0.06)`
  - Pending steps: dark circle with number, muted title, "Locked" status
  - Connector lines (2px) between steps: green if preceding step done, dark otherwise
- Bottom (pinned via `margin-top: auto`):
  - Progress bar with label "Overall Progress", green fill, "Step N of M" text
  - Help link: "Need help? Contact support"

**Content Area**
- `margin-left: 260px` to clear the fixed sidebar
- Full remaining width, no max-width constraint
- Padding: 32px 40px
- Contains: step title (serif h2), step description, tutorial toggle, warning/info boxes, embedded content, action buttons
- Scrolls independently of the fixed sidebar

**Hero Section**
- On desktop: completely hidden (replaced by sidebar)
- On mobile: unchanged — sticky dark hero with horizontal scrollable tabs

### Pages Affected

| Page | Sidebar | Full-width nav |
|------|---------|---------------|
| myinthealth.html | Yes (3 steps) | Yes |
| amc.html | Yes (4 steps) | Yes |
| ahpra.html | Yes (varies) | Yes |
| pbs.html | Yes | Yes |
| commencement.html | Yes | Yes |
| index.html (dashboard) | No | Yes |
| account.html | No | Yes |
| registration-intro.html | No | Yes |
| career.html | No | Yes |
| app-shell.html | N/A | Yes |

### Breakpoint Behavior

- **861px+**: Full-width nav, fixed sidebar, content fills remaining width
- **860px and below**: No changes — mobile layout with sticky hero, scrollable tabs, bottom nav bar

### What Gets Removed on Desktop

- Dark hero section (`hero-compact`) — hidden via `display: none`
- Hero avatar (identity already in nav's account pill)
- Notification bell from hero (stays in app shell or moves to nav)
- `max-width: 960px` constraint from nav and content wrappers
- `dash-wrap` max-width constraint

### What Stays the Same

- All mobile layouts (untouched)
- Step logic, progression, bypass behavior
- Content within each step page
- App shell iframe embedding behavior
- Registration stepper dropdown on dashboard

## Implementation Approach

Each registration step page has its own inline CSS and HTML. The changes per page are:
1. Add sidebar HTML (rendered by JS based on current step data)
2. Add sidebar CSS (desktop media query)
3. Hide `hero-compact` on desktop
4. Remove `max-width: 960px` from `dash-wrap` on desktop
5. Add `margin-left: 260px` to content area on desktop

The sidebar HTML/JS can be a shared function since all step pages already have `BYPASS_LOCK_EMAILS`, step stage data, and tab rendering logic. The existing tab data structures (step arrays with done/active/locked states) feed directly into the sidebar rendering.

`app-shell.html` needs one change: remove `max-width: 960px` from `.app-shell-desktop-inner`.

## Non-Goals

- No changes to mobile layout
- No changes to the dashboard page layout (no sidebar there)
- No changes to step logic or progression rules
- No new pages or routes
