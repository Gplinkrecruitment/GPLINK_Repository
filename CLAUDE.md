# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start              # Run dev server (node server.js) on port 3000
npm run start:prod     # Run with NODE_ENV=production
npm test               # Run tests (vitest run)
npm run test:watch     # Run tests in watch mode (vitest)
npm run init:db        # Initialize local JSON database
```

Single test: `npx vitest run tests/oauth.test.js`

## Architecture

**Monolithic vanilla JS/HTML app** served by a single Node.js server (`server.js`). No frontend framework — pages are plain HTML with inline `<script>` and `<style>` blocks.

### Server (`server.js`)
- Handles ALL routes: API endpoints, static file serving, auth, admin dashboard
- Deployed on Vercel via `@vercel/node` — every request routes through `server.js` (see `vercel.json`)
- Auth: OTP-based login, session cookies (`gp_session` for users, `gp_admin_session` for admin)
- DB: Supabase (production), local JSON file fallback (development)
- Integrations: Zoho Recruit (job sync), Domain API (housing search), Anthropic API (qualification AI verification), OpenAI (career AI profiles)

### App Shell (`pages/app-shell.html` + `js/app-shell.js`)
- Main container that loads pages in an `<iframe>`
- Bottom nav bar, registration progress dropdown, route management
- Communicates with iframed pages via `postMessage` (`gp-shell-route`, `gp-shell-route-ready`)

### Embedded Page Bridge (`js/nav-shell-bridge.js`)
- Loaded by pages when embedded in the app shell
- Sets `--gp-shell-bottom-clearance` CSS variable (nav bar height)
- Adds `gp-shell-embedded` class to `<html>` and `<body>`
- Hides the page's own nav/topbar when embedded

### Key JS Files
- `js/auth-guard.js` — Auth enforcement + restricted mode (loaded on every page)
- `js/state-sync.js` — localStorage <-> Supabase state synchronization
- `js/updates-sync.js` — Notification/alert panel system
- `js/onboarding.js` — 8-step onboarding wizard
- `js/qualification-scan.js` — Document scan modal (qualification verification)
- `js/qualification-camera.js` — Camera viewfinder with hologram brackets
- `js/registration-stepper.js` — Registration progress tracking

### Registration Flow
MyIntealth -> AMC -> Career (job application) -> AHPRA -> Secured Placement -> Visa -> PBS

### Database
- Supabase (PostgreSQL) in production, migrations in `supabase/migrations/`
- Local JSON file at `data/app-db.json` for development

## Conventions

- Cache busters on script tags: `?v=YYYYMMDD[letter]` (e.g., `?v=20260329a`)
- Event delegation preferred (single document-level listener)
- `data-alert-trigger` attribute on bell notification buttons
- `data-qual-scan-trigger` attribute for qualification scan triggers
- Shell navigation from embedded pages: `window.parent.postMessage({ type: "gp-shell-route", href, title }, origin)`
- JS files served with `no-cache` headers to prevent stale scripts
- Restricted mode: `account_status = 'under_review'` limits access to myintealth + account pages only
