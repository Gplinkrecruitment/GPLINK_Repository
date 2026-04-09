# Career Page Completion — Design Spec

## Goal

Complete the GP Link career system so every user interaction leads to a functional, polished page. Build UI first, then connect data sources.

## Scope

### New Standalone Pages (3)

#### 1. Interview Strategy (`pages/interview-prep.html`)

Personalised interview coaching page linked from the interview card on application-detail.html.

**Sections:**
- Practice name + address hero
- Live countdown ring (conic-gradient, JS `setInterval` every 1s) with interview datetime
- Action row: Join Zoom, Add to Calendar, Mock Interview
- Who You're Meeting — interviewer profiles with role tags and personality traits
- Strategy glass section — "How to Succeed in This Interview" with coaching bullets + personal notes textarea (localStorage persistence)
- What This Practice Is Looking For — bullet items with blue/red icons
- What You Should Emphasise — green checkmark bullets
- Mistakes to Avoid — red X bullets
- Questions to Ask — tap-to-copy with toast notification
- Guidance officer (Hazel) with WhatsApp CTA
- Post-interview state — page transforms after interview datetime to "How did it go?" feedback form

**Design:** Glass panels, atmospheric gradients, grain texture, Inter font, auto dark/light via `prefers-color-scheme`. Approved mockup: `.superpowers/brainstorm/7582-1775748515/content/interview-prep-v8-final.html`

#### 2. Offer Review (`pages/offer-review.html`)

Offer review and acceptance page linked when application status is "offer".

**Sections:**
- Pulsing "Offer Received" badge + practice hero
- Response deadline countdown ring (amber)
- Offer Summary — 4 glass stat cards (earnings, billing split, sessions, start date)
- What GP Link Secured — negotiation highlights in glass section with green dots
- Contract Highlights — key terms with icon bullets (indemnity, staff, after-hours, equipment, covenant)
- Your Decision — Accept Offer (green CTA), Request Changes, Download Contract
- Guidance officer (Hazel) with WhatsApp CTA
- Post-accept state — transforms to "Placement Secured" celebration with numbered next steps

**Design mockup:** `.superpowers/brainstorm/7582-1775748515/content/offer-review.html`

#### 3. Area Guide (`pages/area-guide.html`)

Relocation area guide linked from secured placement view.

**Sections (3-tab layout):**
- Overview tab: At a Glance stats (rent, commute, schools, safety), seasonal climate cards, "Why GPs Like This Area" glass section
- Living tab: Cost of living vs national average (color-coded higher/lower), "Getting Around" commute details
- Amenities tab: Nearby essentials with distance markers, explore tiles (Housing Search, School Finder, Google Maps, Council)
- Guidance officer (Hazel) with WhatsApp CTA (persistent across tabs)

**Design mockup:** `.superpowers/brainstorm/7582-1775748515/content/area-guide.html`

### Existing Page Polish (3)

#### 4. `pages/career.html` — Polish

- Wire "View Interview Strategy" link from application cards with interview status
- Wire "Review Offer" link from application cards with offer status
- Wire "Area Guide" link from secured placement view
- Ensure all status pills navigate to correct pages

#### 5. `pages/job.html` — Polish

- Ensure Apply button flow completes without dead ends
- Verify Save/Unsave functionality works
- Confirm CV upload modal functions end-to-end

#### 6. `pages/application-detail.html` — Polish

- Wire "Interview Strategy" button from interview card to `interview-prep.html`
- Wire withdraw button visibility and confirmation
- Add offer status card that links to `offer-review.html`
- Ensure status timeline renders all states correctly

### NOT in scope

- Housing Search page (already fully built inside career.html)
- School Finder page (already fully built inside career.html)
- Backend API endpoints and data connections (separate phase after UI)
- Admin panel changes

## Design System

All pages share:
- **Font:** Inter (400–900 weights)
- **Layout:** max-width 480px, 16px side padding
- **Glass panels:** `backdrop-filter: blur(20px) saturate(1.4)`, translucent backgrounds, inner highlight `inset 0 1px 0`, layered shadows
- **Atmospheric bg:** 3-layer radial gradients + SVG noise grain overlay
- **Back bar:** Sticky, frosted glass with blur(28px)
- **Dark/light:** CSS custom properties with `@media (prefers-color-scheme: dark)` override block
- **Animations:** `fadeUp` keyframe with spring-like cubic-bezier
- **Dividers:** Gradient fade `linear-gradient(90deg, transparent, var(--divider), transparent)`
- **Buttons:** 14px border-radius, translateY(-1px) hover lift
- **Guidance officer:** Green gradient avatar, WhatsApp CTA with green shadow

## Routing

All pages follow existing pattern:
- Served by `server.js` static file handler from `/pages/` directory
- Loaded in app shell iframe via `postMessage`
- Query params for context: `?applicationId=xxx` or `?roleId=xxx`
- Back button uses `window.history.back()` or shell postMessage

## Data Strategy (Phase 2 — after UI)

Deferred to after UI is complete. Each page will initially render with placeholder/demo data matching the mockups, then get wired to real data sources in a follow-up phase.
