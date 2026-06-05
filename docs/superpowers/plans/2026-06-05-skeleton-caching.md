# Skeleton Screen, Service Worker & Auth Pre-warm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GP page transitions feel instant with skeleton screens, service worker pre-caching, and server-side auth pre-warm.

**Architecture:** App shell injects a themed skeleton overlay during navigation and removes it on frame load. Service worker pre-caches all GP HTML/JS on install, serves stale-while-revalidate. Sign-in page fires a background warm request after email input so state is pre-fetched server-side before login completes.

**Tech Stack:** Vanilla JS, service worker API, server.js in-memory cache.

---

### Task 1: Skeleton Screen CSS in app-shell.html

**Files:**
- Modify: `pages/app-shell.html` (add CSS inside existing `<style>` block)

- [ ] **Step 1: Add skeleton + slide CSS to app-shell.html**

Add inside the existing `<style>` block, before the closing `</style>` tag (around line 210):

```css
/* ── Skeleton screen ── */
.gp-skeleton-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: var(--bg, #f0f4fa);
  overflow: hidden;
}
.gp-skeleton-overlay .sk-hero {
  height: 120px;
  background: linear-gradient(170deg, #0c1222, #162036);
  border-radius: 0 0 20px 20px;
  position: relative;
  overflow: hidden;
  padding: 24px 20px;
}
.gp-skeleton-overlay .sk-hero::before {
  content: "";
  position: absolute; inset: 0;
  background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  background-size: 200px; opacity: 0.5; pointer-events: none;
}
.gp-skeleton-overlay .sk-hero-row { display: flex; align-items: center; gap: 12px; position: relative; z-index: 1; }
.gp-skeleton-overlay .sk-avatar { width: 38px; height: 38px; border-radius: 50%; background: rgba(255,255,255,0.1); }
.gp-skeleton-overlay .sk-lines { display: flex; flex-direction: column; gap: 6px; }
.gp-skeleton-overlay .sk-line { height: 12px; border-radius: 6px; }
.gp-skeleton-overlay .sk-line-dark { background: rgba(255,255,255,0.12); }
.gp-skeleton-overlay .sk-line-light { background: #dde1ea; }
.gp-skeleton-overlay .sk-w1 { width: 120px; }
.gp-skeleton-overlay .sk-w2 { width: 80px; }
.gp-skeleton-overlay .sk-w3 { width: 55%; }
.gp-skeleton-overlay .sk-w4 { width: 85%; }
.gp-skeleton-overlay .sk-w5 { width: 60%; }
.gp-skeleton-overlay .sk-w6 { width: 70%; }
.gp-skeleton-overlay .sk-w7 { width: 50%; }
.gp-skeleton-overlay .sk-progress { margin-top: 16px; position: relative; z-index: 1; }
.gp-skeleton-overlay .sk-progress-bar { height: 10px; border-radius: 5px; background: rgba(255,255,255,0.08); width: 100%; }
.gp-skeleton-overlay .sk-progress-fill { height: 10px; border-radius: 5px; background: rgba(26,86,219,0.5); width: 40%; margin-top: -10px; }
.gp-skeleton-overlay .sk-tabs { display: flex; border-bottom: 1px solid #e4e7ee; }
.gp-skeleton-overlay .sk-tab { flex: 1; height: 44px; display: flex; align-items: center; justify-content: center; }
.gp-skeleton-overlay .sk-tab-inner { width: 60px; height: 12px; border-radius: 6px; background: #dde1ea; }
.gp-skeleton-overlay .sk-tab.active { border-bottom: 2px solid #1a56db; }
.gp-skeleton-overlay .sk-tab.active .sk-tab-inner { background: rgba(26,86,219,0.3); }
.gp-skeleton-overlay .sk-content { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.gp-skeleton-overlay .sk-block { border-radius: 12px; background: #e4e7ee; height: 14px; }
.gp-skeleton-overlay .sk-card {
  background: #fff; border: 1px solid #e4e7ee; border-radius: 14px;
  padding: 18px; display: flex; align-items: center; gap: 10px;
}
.gp-skeleton-overlay .sk-card-icon { width: 32px; height: 32px; border-radius: 8px; background: #eef0f5; flex-shrink: 0; }
.gp-skeleton-overlay .sk-card-lines { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.gp-skeleton-overlay .sk-card-line { height: 10px; border-radius: 5px; background: #eef0f5; }
.gp-skeleton-overlay .sk-btn { width: 100%; height: 44px; border-radius: 10px; background: rgba(26,86,219,0.15); }
@keyframes gp-shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}
.sk-shimmer {
  background-image: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.35) 50%, transparent 100%);
  background-size: 400px 100%; background-repeat: no-repeat;
  animation: gp-shimmer 1.6s ease-in-out infinite;
}
.sk-shimmer-dark {
  background-image: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.06) 50%, transparent 100%);
  background-size: 400px 100%; background-repeat: no-repeat;
  animation: gp-shimmer 1.6s ease-in-out infinite;
}
/* ── Mobile slide-in ── */
@keyframes gp-slide-in {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
.gp-frame-slide-in {
  animation: gp-slide-in 250ms ease-out forwards;
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/app-shell.html
git commit -m "feat: add skeleton screen and slide-in CSS to app shell"
```

---

### Task 2: Skeleton Injection/Removal in app-shell.js

**Files:**
- Modify: `js/app-shell.js`

- [ ] **Step 1: Add skeleton helper functions after the `setLoading` function (around line 784)**

Add after the `setLoading` function:

```js
  // ── Skeleton screen ──────────────────────────────────────────
  var skeletonEl = null;
  var skeletonTimer = null;

  function createSkeleton() {
    var el = document.createElement("div");
    el.className = "gp-skeleton-overlay";
    el.innerHTML = [
      '<div class="sk-hero">',
        '<div class="sk-hero-row">',
          '<div class="sk-avatar sk-shimmer-dark"></div>',
          '<div class="sk-lines">',
            '<div class="sk-line sk-line-dark sk-w1 sk-shimmer-dark"></div>',
            '<div class="sk-line sk-line-dark sk-w2 sk-shimmer-dark"></div>',
          '</div>',
        '</div>',
        '<div class="sk-progress">',
          '<div class="sk-progress-bar sk-shimmer-dark"></div>',
          '<div class="sk-progress-fill"></div>',
        '</div>',
      '</div>',
      '<div class="sk-tabs">',
        '<div class="sk-tab active"><div class="sk-tab-inner sk-shimmer"></div></div>',
        '<div class="sk-tab"><div class="sk-tab-inner sk-shimmer"></div></div>',
      '</div>',
      '<div class="sk-content">',
        '<div class="sk-block sk-w3 sk-shimmer"></div>',
        '<div class="sk-block sk-w4 sk-shimmer"></div>',
        '<div class="sk-block sk-w5 sk-shimmer"></div>',
        '<div class="sk-card">',
          '<div class="sk-card-icon sk-shimmer"></div>',
          '<div class="sk-card-lines">',
            '<div class="sk-card-line sk-w6 sk-shimmer"></div>',
            '<div class="sk-card-line sk-w7 sk-shimmer"></div>',
          '</div>',
        '</div>',
        '<div class="sk-card">',
          '<div class="sk-card-icon sk-shimmer"></div>',
          '<div class="sk-card-lines">',
            '<div class="sk-card-line sk-w6 sk-shimmer"></div>',
            '<div class="sk-card-line sk-w7 sk-shimmer"></div>',
          '</div>',
        '</div>',
        '<div class="sk-btn sk-shimmer"></div>',
      '</div>'
    ].join("");
    return el;
  }

  function showSkeleton() {
    removeSkeleton();
    var stack = document.getElementById("appShellFrameStack");
    if (!stack) return;
    skeletonEl = createSkeleton();
    if (window.innerWidth < 769) {
      skeletonEl.classList.add("gp-frame-slide-in");
    }
    stack.appendChild(skeletonEl);
    skeletonTimer = setTimeout(removeSkeleton, 6000);
  }

  function removeSkeleton() {
    if (skeletonTimer) { clearTimeout(skeletonTimer); skeletonTimer = null; }
    if (skeletonEl && skeletonEl.parentNode) {
      skeletonEl.parentNode.removeChild(skeletonEl);
    }
    skeletonEl = null;
  }
```

- [ ] **Step 2: Call `showSkeleton()` in `navigateTo` when loading a new route**

Find the line in `navigateTo` that says `loadRouteIntoFrame(targetFrame, embeddedRoute, route);` (around line 1057). Add `showSkeleton();` immediately BEFORE that line:

```js
    showSkeleton();
    loadRouteIntoFrame(targetFrame, embeddedRoute, route);
```

- [ ] **Step 3: Call `removeSkeleton()` in `handleFrameLoad` when navigation completes**

Find the line `if (frame !== activeFrameEl) activateFrame(frame);` inside the `pendingNavigation` check in `handleFrameLoad`. Add `removeSkeleton();` right after `setLoading(false);` in that block:

```js
      if (pendingNavigation && (pendingNavigation.route === nextRoute || routesShareSupportedPage(pendingNavigation.route, nextRoute))) {
        if (frame !== activeFrameEl) activateFrame(frame);
        setLoading(false);
        removeSkeleton();
```

Also add `removeSkeleton();` in the `frame === activeFrameEl && !pendingNavigation` block:

```js
      if (frame === activeFrameEl && !pendingNavigation) {
        setLoading(false);
        removeSkeleton();
```

Also add `removeSkeleton();` in the handleMessage self-navigation sync block (the `activePath` check added previously) after `setLoading(false);`:

```js
          setLoading(false);
          removeSkeleton();
```

- [ ] **Step 4: Also remove skeleton when cached frame is activated**

In `navigateTo`, in the `cachedFrame` block, add `removeSkeleton();` after `setLoading(false);`:

```js
    if (cachedFrame) {
      activateFrame(cachedFrame);
      setLoading(false);
      removeSkeleton();
```

- [ ] **Step 5: Update cache buster**

In `pages/app-shell.html`, update the app-shell.js script tag cache buster:

```
app-shell.js?v=20260605c
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run
```

Expected: 249 tests pass.

- [ ] **Step 7: Commit**

```bash
git add js/app-shell.js pages/app-shell.html
git commit -m "feat: skeleton screen with shimmer during page transitions"
```

---

### Task 3: Service Worker Update

**Files:**
- Modify: `sw.js`

- [ ] **Step 1: Update CORE_URLS and VERSION in sw.js**

Replace the existing `VERSION` and `CORE_URLS` block (lines 5-22) with:

```js
  var VERSION = "20260605a";
  var STATIC_CACHE = "gp-link-static-" + VERSION;
  var PAGE_CACHE = "gp-link-pages-" + VERSION;
  var RUNTIME_CACHE = "gp-link-runtime-" + VERSION;
  var CACHE_NAMES = [STATIC_CACHE, PAGE_CACHE, RUNTIME_CACHE];
  var PAGE_TIMEOUT_MS = 1200;

  var CORE_URLS = [
    "/pages/app-shell.html",
    "/pages/index.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/myinthealth.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/amc.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/ahpra.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/career.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/visa.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/pbs.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/commencement.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/messages.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/account.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/my-documents.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/registration-intro.html?gp_shell=embedded&gp_shell_static=1",
    "/pages/signin.html",
    "/js/app-shell.js?v=20260605c",
    "/js/nav-shell-bridge.js?v=20260527a",
    "/js/auth-guard.js?v=20260528a",
    "/js/state-sync.js?v=20260604a",
    "/js/bypass-config.js?v=20260602a",
    "/js/updates-sync.js?v=20260527a",
    "/js/qualification-scan.js?v=20260527a",
    "/js/qualification-camera.js?v=20260527a",
    "/js/account-dropdown.js?v=20260527a",
    "/js/onboarding.js?v=20260527a",
    "/js/error-reporter.js?v=20260527a"
  ];
```

- [ ] **Step 2: Register service worker in app-shell.html**

Add before the closing `</body>` tag in `pages/app-shell.html`:

```html
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function () {});
}
</script>
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run
```

Expected: 249 tests pass.

- [ ] **Step 4: Commit**

```bash
git add sw.js pages/app-shell.html
git commit -m "feat: service worker pre-caches all GP pages and JS on install"
```

---

### Task 4: Auth Pre-warm Server Endpoint

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add warm cache map near the top of server.js (after existing constants, around line 3400)**

```js
// ── Auth pre-warm cache ──────────────────────────────────────
var _warmCache = new Map();
var WARM_CACHE_TTL_MS = 60000;
var WARM_CACHE_MAX = 100;

function warmCacheSet(email, state) {
  if (_warmCache.size >= WARM_CACHE_MAX) {
    var oldest = _warmCache.keys().next().value;
    _warmCache.delete(oldest);
  }
  _warmCache.set(email.toLowerCase(), { state: state, ts: Date.now() });
}

function warmCacheGet(email) {
  var key = email.toLowerCase();
  var entry = _warmCache.get(key);
  if (!entry) return null;
  _warmCache.delete(key);
  if (Date.now() - entry.ts > WARM_CACHE_TTL_MS) return null;
  return entry.state;
}
```

- [ ] **Step 2: Add `POST /api/auth/warm` endpoint**

Find the section where auth endpoints are defined (search for `api/auth/login`). Add BEFORE the login handler:

```js
  if (req.method === 'POST' && pathname === '/api/auth/warm') {
    var warmBody;
    try { warmBody = typeof req.body === 'object' ? req.body : JSON.parse(await readRawBody(req)); } catch (e) { sendJson(res, 400, { ok: false }); return; }
    var warmEmail = String(warmBody && warmBody.email || '').trim().toLowerCase();
    if (!warmEmail || !warmEmail.includes('@')) { sendJson(res, 200, { ok: true }); return; }
    // Fire-and-forget: fetch state and cache it server-side
    (async function () {
      try {
        if (!isSupabaseDbConfigured()) return;
        var row = await getSupabaseUserStateByEmail(warmEmail);
        if (row && row.state) warmCacheSet(warmEmail, row.state);
      } catch (e) {}
    })();
    sendJson(res, 200, { ok: true });
    return;
  }
```

- [ ] **Step 3: Use warm cache in `GET /api/state` handler**

Find the `GET /api/state` handler (search for `req.method === 'GET' && pathname === '/api/state'`). Inside it, find where it fetches state from Supabase. Add a warm cache check BEFORE the Supabase fetch:

Find the line that calls `getSupabaseUserStateByEmail` or reads from the database in the GET /api/state handler. Add before it:

```js
    // Check auth pre-warm cache first
    var warmState = warmCacheGet(email);
    if (warmState) {
      sendJson(res, 200, { ok: true, state: warmState, resetAt: Number(warmState.__gp_reset_at) || 0 });
      return;
    }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run
```

Expected: 249 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: auth pre-warm endpoint caches state server-side before login"
```

---

### Task 5: Sign-in Page Warm Trigger

**Files:**
- Modify: `pages/signin.html`

- [ ] **Step 1: Add warm trigger on email field blur**

Find the sign-in form event setup area (around line 1206 where `signInFormEl.addEventListener("submit", ...)` is). Add BEFORE the submit listener:

```js
    // Pre-warm server-side state cache when user moves to password field
    var warmFired = false;
    var signinEmailEl = document.getElementById("signinEmail");
    if (signinEmailEl) {
      signinEmailEl.addEventListener("blur", function () {
        if (warmFired) return;
        var email = signinEmailEl.value.trim();
        if (!email || !email.includes("@")) return;
        warmFired = true;
        fetch("/api/auth/warm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email })
        }).catch(function () {});
      });
    }
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run
```

Expected: 249 tests pass.

- [ ] **Step 3: Commit**

```bash
git add pages/signin.html
git commit -m "feat: sign-in page fires pre-warm on email blur"
```

---

### Task 6: Deploy to Development

- [ ] **Step 1: Push all changes**

```bash
git push
```

- [ ] **Step 2: Verify deployment**

Check the Vercel dashboard for a successful deployment on the `main` branch.

- [ ] **Step 3: Test skeleton screen**

Navigate between pages in the GP app. Verify:
- Skeleton with dark hero header appears during transitions
- Skeleton is removed when the page finishes loading
- On mobile: skeleton slides in from the right
- On desktop: skeleton appears instantly (no slide)

- [ ] **Step 4: Test service worker**

1. Open DevTools → Application → Service Workers. Verify `sw.js` is registered.
2. Open DevTools → Application → Cache Storage. Verify `gp-link-static-20260605a` contains all GP page HTML and JS files.
3. Navigate to AHPRA, then navigate back. Second navigation should be noticeably faster.

- [ ] **Step 5: Test auth pre-warm**

1. Sign out
2. On sign-in page, enter email and tab to password field
3. Check Network tab: `POST /api/auth/warm` should fire
4. Enter password and sign in
5. Check Network tab: `GET /api/state` on the home page should complete faster (served from warm cache)
