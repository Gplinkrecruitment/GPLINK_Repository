# Admin Impersonate GP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admin and super_admin users open a new browser tab showing the app exactly as a specific GP sees it, with a visible banner indicating impersonation mode.

**Architecture:** A single GET endpoint (`/api/admin/impersonate`) validates the admin session cookie, looks up the target GP's profile, sets a `gp_session` cookie with an `_impersonatedBy` marker, and redirects to the app homepage. The frontend (`auth-guard.js`) detects the marker and injects a floating banner with the GP's name and an exit button. The admin dashboard adds a "View as GP" button in the profile bar.

**Tech Stack:** Vanilla JS, Node.js server (`server.js`), existing signed session tokens, Supabase user_profiles table.

---

### Task 1: Add the impersonate API endpoint to server.js

**Files:**
- Modify: `server.js` — add endpoint near the admin auth block (around line 21398)

- [ ] **Step 1: Find insertion point**

The endpoint goes right before the existing `/api/admin/auth/session` handler at line 21398. Read that area to confirm.

- [ ] **Step 2: Add the impersonate endpoint**

Insert the following block **before** the line `if (pathname === '/api/admin/auth/session' && req.method === 'GET') {`:

```javascript
  // ── Admin impersonate GP ───────────────────────────────────
  if (pathname === '/api/admin/impersonate' && req.method === 'GET') {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { ok: false, message: 'Admin session required.' });
      return;
    }
    const adminEmail = getSessionEmail(adminSession);
    const adminRole = getAdminRoleFromSession(adminSession);
    if (!hasAdminPortalAccess(adminRole)) {
      sendJson(res, 403, { ok: false, message: 'Admin access required.' });
      return;
    }

    const userId = url.searchParams.get('user_id') || '';
    if (!userId) {
      sendJson(res, 400, { ok: false, message: 'user_id query parameter required.' });
      return;
    }

    // Look up GP profile from Supabase
    let gpEmail = '';
    let firstName = '';
    let lastName = '';
    let registrationCountry = '';

    if (isSupabaseDbConfigured()) {
      const profileRes = await supabaseDbRequest(
        'user_profiles',
        'select=email,first_name,last_name,registration_country&user_id=eq.' + encodeURIComponent(userId) + '&limit=1'
      );
      const row = profileRes.ok && Array.isArray(profileRes.data) && profileRes.data[0] ? profileRes.data[0] : null;
      if (!row || !row.email) {
        sendJson(res, 404, { ok: false, message: 'GP user not found.' });
        return;
      }
      gpEmail = String(row.email).trim().toLowerCase();
      firstName = row.first_name || '';
      lastName = row.last_name || '';
      registrationCountry = row.registration_country || '';
    } else {
      // Local DB fallback
      const allUsers = dbState.users || {};
      const match = Object.values(allUsers).find(u => u.supabaseUserId === userId);
      if (!match || !match.email) {
        sendJson(res, 404, { ok: false, message: 'GP user not found.' });
        return;
      }
      gpEmail = String(match.email).trim().toLowerCase();
      firstName = match.firstName || '';
      lastName = match.lastName || '';
      registrationCountry = match.registrationCountry || '';
    }

    const gpProfile = {
      firstName,
      lastName,
      email: gpEmail,
      supabaseUserId: userId,
      countryDial: '',
      phoneNumber: '',
      registrationCountry,
      _impersonatedBy: adminEmail
    };

    console.log('[Admin] Impersonate GP:', gpEmail, 'by admin:', adminEmail);
    setSession(res, gpProfile);

    const redirectTo = buildAbsoluteReturnUrl(req, '/pages/index.html');
    res.writeHead(302, { Location: redirectTo });
    res.end();
    return;
  }
```

- [ ] **Step 3: Verify the endpoint returns the `_impersonatedBy` field through the session**

Check that `parseSignedSessionToken` returns the full `userProfile` object including arbitrary keys like `_impersonatedBy`. Reading the existing code at line 2660-2665 confirms it does — it parses `parsed.userProfile` as a plain object, so extra keys pass through.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add /api/admin/impersonate endpoint for admin GP view-as"
```

---

### Task 2: Expose `_impersonatedBy` in the session API response

**Files:**
- Modify: `server.js:17116-17128` — the `/api/auth/session` GET handler

- [ ] **Step 1: Read the current handler**

The handler at line 17122 returns `{ ok: true, authenticated: true, profile: session.userProfile }`. Since `session.userProfile` already contains the `_impersonatedBy` field (it was stored in the signed token), no changes are needed — the field flows through automatically.

**No code change required.** The `_impersonatedBy` key is part of `userProfile` and is already returned verbatim. Move on.

---

### Task 3: Add impersonation banner to auth-guard.js

**Files:**
- Modify: `js/auth-guard.js` — inject banner when `_impersonatedBy` is present in the session profile

- [ ] **Step 1: Add the banner injection function**

Add the following function inside the IIFE, after the `enforceRestrictedUI` function definition (around line 139 area — after that function ends):

```javascript
  function showImpersonationBanner(profile) {
    var impBy = profile && profile._impersonatedBy;
    if (!impBy) return;
    var gpName = ((profile.firstName || '') + ' ' + (profile.lastName || '')).trim() || profile.email || 'Unknown GP';
    var bar = document.createElement('div');
    bar.id = 'gp-impersonation-banner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#d97706;color:#fff;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 16px;font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    bar.innerHTML = '<span>Viewing as <strong>' + gpName.replace(/</g, '&lt;') + '</strong></span>'
      + '<button id="gp-impersonation-exit" style="background:#fff;color:#d97706;border:none;border-radius:4px;padding:4px 12px;font:600 12px/1 system-ui,sans-serif;cursor:pointer">Exit</button>';
    document.body.appendChild(bar);
    document.documentElement.style.setProperty('--gp-impersonation-offset', '40px');
    document.body.style.paddingTop = '40px';
    document.getElementById('gp-impersonation-exit').addEventListener('click', function () {
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
        .finally(function () { window.close(); });
    });
  }
```

- [ ] **Step 2: Call the banner function from the session callback**

Inside the `sessionPromise.then` handler, right after the line `window.gpSessionProfile = session.profile || window.gpSessionProfile || null;` (line 84), add:

```javascript
      showImpersonationBanner(session.profile);
```

- [ ] **Step 3: Verify the banner does not break restricted mode or other flows**

The banner is purely additive — it appends a DOM element and adjusts padding. It runs after the session profile is set, before the restricted-mode check. No interference.

- [ ] **Step 4: Commit**

```bash
git add js/auth-guard.js
git commit -m "feat: show impersonation banner when admin views as GP"
```

---

### Task 4: Add "View as GP" button to admin dashboard

**Files:**
- Modify: `pages/admin.html` — add button in the profile bar pills area (~line 2412-2417)

- [ ] **Step 1: Add the button to the profile bar HTML**

In the `renderDetail` function, find the `<div class="pb-pills">` block (line 2412). Add the "View as GP" button right after the Nudge button (line 2416), before the closing `</div>`:

```javascript
            <button class="btn sm" data-impersonate-gp="${esc(c.user_id||u.userId||"")}" style="font-size:10px;padding:3px 8px;background:#d97706;color:#fff">View as GP</button>
```

The full pb-pills div will look like:

```javascript
          <div class="pb-pills">
            <span class="pb-pill case-stage-pill stage-${esc(c.stage||'')}">${esc(c.stage||'')}</span>
            <span class="pb-pill" style="background:var(--bg2);color:var(--muted)">${u.quals_approved||0}/${u.quals_required||0} docs</span>
            ${hasDt?'<a class="btn sm dt" href="'+safeUrl(dtUrl)+'" target="_blank" rel="noopener" style="font-size:10px;padding:3px 8px">WhatsApp</a>':''}
            <button class="btn sm nudge" data-case-nudge="${esc(c.user_id||u.userId||"")}" data-nudge-stage="${esc(c.stage||"")}" data-nudge-substage="${esc(c.substage||"")}" data-nudge-name="${esc(((gpName).split(" ")[0]||"").trim())}" style="font-size:10px;padding:3px 8px">Nudge</button>
            <button class="btn sm" data-impersonate-gp="${esc(c.user_id||u.userId||"")}" style="font-size:10px;padding:3px 8px;background:#d97706;color:#fff">View as GP</button>
          </div>
```

- [ ] **Step 2: Add click handler via event delegation**

Find the existing document-level click delegation in admin.html (the main `document.addEventListener("click", ...)` block). Add a handler for `data-impersonate-gp`:

```javascript
    const impersonateBtn = e.target.closest('[data-impersonate-gp]');
    if (impersonateBtn) {
      e.preventDefault();
      const userId = impersonateBtn.getAttribute('data-impersonate-gp');
      if (userId) {
        window.open('/api/admin/impersonate?user_id=' + encodeURIComponent(userId), '_blank');
      }
      return;
    }
```

Find the right insertion point by searching for an existing `e.target.closest` handler in the main click listener.

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add View as GP button to admin dashboard profile bar"
```

---

### Task 5: Update cache busters and test end-to-end

**Files:**
- Modify: Any HTML files that reference `js/auth-guard.js` — update cache buster query param

- [ ] **Step 1: Find all references to auth-guard.js**

```bash
grep -rn 'auth-guard.js' pages/ --include='*.html'
```

Update the `?v=` suffix on each `<script>` tag to `?v=20260518a`.

- [ ] **Step 2: Test locally**

Run `npm start` and:
1. Sign in to the admin dashboard
2. Select a GP from the case list
3. Click "View as GP" — a new tab should open showing the GP's dashboard
4. The amber banner at the top should show "Viewing as [GP Name]"
5. Click "Exit" — the tab should close
6. Return to the admin tab — admin session should still be intact

- [ ] **Step 3: Final commit and push**

```bash
git add -A
git commit -m "chore: update auth-guard cache busters for impersonation feature"
git push
```
