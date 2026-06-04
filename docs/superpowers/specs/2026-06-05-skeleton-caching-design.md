# Skeleton Screen, Service Worker Caching & Auth Pre-warm

**Date:** 2026-06-05
**Status:** Design approved, pending implementation

---

## Problem

GP-facing pages inside the app shell load slowly. The iframe fetches HTML, JS, and then waits for API data before rendering. Users see a blank white frame during transitions. On mobile this feels especially sluggish.

## Solution

Three complementary changes that together make page loads feel instant:

1. **Skeleton screen** — immediate visual feedback during page transitions
2. **Service worker** — cache all GP assets so subsequent loads are instant
3. **Auth pre-warm** — server-side state cache triggered at email input, eliminating a Supabase round-trip after login

---

## 1. Skeleton Screen

### What

A themed skeleton overlay injected by the app shell during page transitions. Matches the GP page layout: dark gradient hero header, tab bar, info card shapes, CTA button — all with shimmer animation.

### Where

All skeleton HTML and CSS lives in `js/app-shell.js` (injected dynamically). No changes to individual GP pages.

### Lifecycle

1. `navigateTo()` is called
2. Skeleton overlay is created and inserted into `.app-shell-frame-stack` with `z-index: 10`
3. On mobile (<769px): skeleton slides in from the right via `translateX(100%)` → `translateX(0)` over 250ms ease-out
4. On desktop: skeleton appears instantly (no slide)
5. Skeleton is removed when `handleFrameLoad` fires for the target route
6. Safety timeout: skeleton auto-removes after 6 seconds (fallback if load event doesn't fire)

### Skeleton Structure

```
┌─────────────────────────────┐
│  Dark gradient hero         │
│  ┌──┐ ████████              │
│  │  │ █████                 │  ← Avatar circle + text lines (shimmer-dark)
│  └──┘                       │
│  ░░░░░░░░░░░░░░░░░░░░░░░░  │  ← Progress bar shape
└─────────────────────────────┘
│  [ Tab 1 ]  [ Tab 2 ]      │  ← Tab bar with shimmer blocks
├─────────────────────────────┤
│  ████████████               │  ← Title block
│  ██████████████████         │  ← Text line
│  ████████████               │  ← Text line
│                             │
│  ┌─────────────────────┐    │
│  │ ┌──┐ ██████████     │    │  ← Info card with icon + lines
│  │ └──┘ ████████       │    │
│  └─────────────────────┘    │
│  ┌─────────────────────┐    │
│  │ ┌──┐ ██████████     │    │  ← Info card
│  │ └──┘ ████████       │    │
│  └─────────────────────┘    │
│                             │
│  ┌─────────────────────┐    │
│  │      CTA Button     │    │  ← Button shape (accent tint)
│  └─────────────────────┘    │
└─────────────────────────────┘
```

### Shimmer Animation

- Light content blocks: `linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)` sliding left-to-right, 1.6s ease-in-out infinite
- Dark hero blocks: same but with `rgba(255,255,255,0.06)` for subtlety against the dark background

### Mobile Slide Transition

- Incoming frame gets class `gp-frame-slide-in` with CSS:
  ```css
  .gp-frame-slide-in {
    transform: translateX(100%);
    animation: gp-slide-in 250ms ease-out forwards;
  }
  @keyframes gp-slide-in {
    to { transform: translateX(0); }
  }
  ```
- Only applied when `window.innerWidth < 769`
- Old frame stays in place underneath — no exit animation
- Slide class removed after animation completes

---

## 2. Service Worker Caching

### Strategy: Pre-cache on install + stale-while-revalidate on fetch

### Install Phase

On service worker install, immediately cache ALL GP page HTML and core JS files:

**HTML files:**
- `/pages/app-shell.html`
- `/pages/index.html`
- `/pages/myinthealth.html`
- `/pages/amc.html`
- `/pages/ahpra.html`
- `/pages/career.html`
- `/pages/visa.html`
- `/pages/pbs.html`
- `/pages/commencement.html`
- `/pages/messages.html`
- `/pages/account.html`
- `/pages/my-documents.html`
- `/pages/registration-intro.html`
- `/pages/signin.html`

**JS files:**
- `/js/app-shell.js`
- `/js/state-sync.js`
- `/js/auth-guard.js`
- `/js/nav-shell-bridge.js`
- `/js/bypass-config.js`
- `/js/updates-sync.js`
- `/js/qualification-scan.js`
- `/js/qualification-camera.js`
- `/js/account-dropdown.js`
- `/js/onboarding.js`
- `/js/error-reporter.js`

**CSS/fonts:** External Google Fonts are NOT cached (served from CDN with its own cache).

### Fetch Handler

For same-origin requests matching `/pages/*.html` or `/js/*.js`:
1. Return cached version immediately (if available)
2. Fetch fresh version from network in background
3. Update cache with fresh version
4. Next request gets the fresh version

For everything else (`/api/*`, external origins, media files): pass through to network, no caching.

### Cache Versioning

```js
var CACHE_VERSION = "gp-v1";
```

On activate, delete any caches that don't match `CACHE_VERSION`. Bump the version when deploying breaking changes that require a clean cache.

### Registration

App shell registers the service worker:
```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
```

Registered once in `app-shell.html`. No registration in individual pages.

### Result

- First page load: normal speed (files downloaded and cached)
- All other GP pages (even unvisited): served from cache because pre-cached on install
- Combined with skeleton: click → skeleton appears instantly → cached page renders in ~100ms

---

## 3. Auth Pre-warm

### Flow

1. User enters email on sign-in page, tabs/clicks to password field
2. Client sends `POST /api/auth/warm` with `{ email }` (fire-and-forget, no await)
3. Server fetches user state from Supabase, stores in short-lived in-memory cache (keyed by normalized email, TTL 60 seconds)
4. Server responds `{ ok: true }` — no user data returned to client
5. User enters password, submits sign-in form
6. Auth validates credentials, creates session, redirects to home
7. Home page loads, state-sync calls `GET /api/state`
8. Server checks warm cache — if hit, serves from memory instead of Supabase
9. Warm cache entry consumed after use (one-shot)

### Server Implementation

```
In-memory map:  warmCache = new Map()
Entry shape:    { state: {...}, timestamp: Date.now() }
TTL:            60 seconds
Cleanup:        Entries older than TTL removed on access or via periodic sweep
Max entries:    100 (prevent memory issues from abuse)
```

### Endpoint: `POST /api/auth/warm`

- Accepts: `{ email: string }`
- Validates: email format only (no auth check)
- Action: fetches user state from Supabase, caches server-side
- Returns: `{ ok: true }` always (same response whether user exists or not — prevents enumeration)
- Rate limit: 10 requests per minute per IP
- No session required

### State-sync Integration

In `GET /api/state` handler, before querying Supabase:
```
Check warmCache for session email
  → if hit and not expired: return cached state, delete entry
  → if miss: query Supabase as normal
```

### Security

- No user data returned from the warm endpoint
- Response is identical whether email exists or not
- Rate-limited to prevent abuse
- Cache entries auto-expire after 60 seconds
- One-shot consumption: entry deleted after first use

---

## Files Changed

| File | Change |
|---|---|
| `js/app-shell.js` | Skeleton injection/removal in `navigateTo` and `handleFrameLoad`. Mobile slide animation. |
| `pages/app-shell.html` | Skeleton CSS. Slide animation CSS. Service worker registration. |
| `sw.js` | Full rewrite: pre-cache on install, stale-while-revalidate fetch handler, cache versioning. |
| `server.js` | `POST /api/auth/warm` endpoint. Warm cache map. Cache check in `GET /api/state`. |
| `pages/signin.html` | Email field blur listener to fire warm request. |

---

## What This Does NOT Change

- No changes to individual GP page files (amc.html, ahpra.html, etc.)
- No changes to the registration flow or state-sync merge logic
- No changes to admin pages
- No offline mode (service worker only caches for speed, not offline use)
