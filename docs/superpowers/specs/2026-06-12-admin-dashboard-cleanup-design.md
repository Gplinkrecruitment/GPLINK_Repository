# Admin Dashboard Bug Fix + UI Cleanup — Design

**Date:** 2026-06-12
**Scope:** `pages/admin.html` (main admin dashboard, 9,125 lines)
**Deliverable:** Preview branch deployment (NOT production)

## Context

Full audit of the admin dashboard (structure, API wiring, JS bugs, UI quality) found:

- **API wiring is healthy.** All 80 distinct `/api/admin/*` fetch calls in admin.html were
  cross-checked against `server.js` handlers — every path, method, and query param matches.
  No dead endpoints.
- **Three JS bug classes** in the inline script.
- **Severe visual inconsistency** ("vibe coded" look): 157 distinct hardcoded colors
  bypassing 19 CSS variables, 20+ font sizes, invalid font-weights (760, 850),
  15 border-radius values, 22 shadow styles, 394 inline `style=` attributes,
  21 button classes and 60+ card classes with no shared base, 3 inconsistent
  responsive breakpoints (600/700/900px).

`admin-pbs.html` is a clean, isolated 765-line page sharing no styling with admin.html —
out of scope. `admin-visa.html` is deferred from v1 — out of scope.

## Assumptions (autonomous run — user not available for questions)

1. "Clean up the interface" = visual consistency within the existing layout and brand
   (purple top bar, DM Sans, card-based panels) — NOT a redesign of navigation or features.
2. No class renames in JS-generated HTML strings. The 7,650-line inline script builds
   markup via string concatenation; renaming classes there is high-risk. Cleanup happens
   by normalizing CSS *values* behind the existing class names.
3. Inline `style="display:none"` toggles stay as-is — JS toggles visibility via
   `el.style.display`, and converting to classes would silently break show/hide logic.
4. Deploy = push the feature branch to GitHub (Vercel builds a preview automatically)
   plus an explicit `vercel` preview deploy. No merge to main, no production promote.

## Part 1 — Bug fixes (functional)

### 1a. Unescaped `task.id` in inline event handlers
~13 occurrences (lines ~1701–1807) concatenate `task.id` raw into `onclick="...('<id>')"`
strings, while sibling code correctly uses `escAttr(task.id)`. A quote or HTML metachar in
an ID breaks the attribute (and is an XSS vector). Fix: wrap every interpolated id in
these handler strings with `escAttr(...)`, matching the existing pattern.

### 1b. Unguarded `JSON.parse` in timeline merge
Line ~3087: `JSON.parse(m.attachments||'[]')` — malformed JSON from one message kills the
whole timeline render. Fix: try/catch with `[]` fallback, matching the file's existing
guarded-parse pattern (e.g. lines 4570, 5043).

### 1c. `addEventListener` on possibly-null elements
~11 call sites chain `.addEventListener` directly on `getElementById(...)` for elements
that may not be in the DOM (some views render conditionally). One missing element throws
and aborts the rest of the init block. Fix: null-guard each static-element binding
(`var el = ...; if (el) el.addEventListener(...)`); leave the ones that bind to
just-created nodes alone.

## Part 2 — UI cleanup (visual)

All changes confined to the `<style>` block (lines 12–1274) and the static HTML markup
(lines 1278–1474). JS-generated markup untouched except where Part 1 requires.

### 2a. Design tokens
Expand `:root` into a real token set and route existing rules through it:
- **Colors:** consolidate the 25+ ad-hoc blues to the `--blue` family
  (`--blue`, `--blue-dark`, `--blue-bg`), add named tokens for the recurring neutrals
  (`#f8fafc`, `#f1f5f9`, `#eff6ff`, `#fef2f2` etc. → `--surface-1/-2`, tint tokens),
  and per-status tint pairs for stage pills / task badges. Target: every color in the
  style block is either a token or a deliberate one-off (status tints may stay as a
  documented tint map).
- **Type scale:** `--fs-xs/sm/base/md/lg/xl` (11/12/13/14/16/18px + display sizes);
  replace invalid font-weights 760→700 and 850→800; collapse stray sizes
  (9px, 12.5px, mixed rem) onto the scale.
- **Spacing/radius/shadow:** `--r-sm:6px --r-md:8px --r-lg:12px --r-full:999px`;
  2 shadow tokens (`--shadow-sm`, `--shadow-lg`); normalize the 99px/999px pill split.

### 2b. Component normalization (no renames)
- **Buttons:** one grouped rule giving all 21 button classes consistent height, padding,
  radius, font-size/weight, and transition; per-class rules keep only their color intent.
- **Cards:** one grouped rule giving the card classes (`.case-card`, `.app-admin-card`,
  `.iv-card`, `.ticket-card`, …) shared background/border/radius/padding; remove the
  duplicated declarations.
- **Modals:** align `.modal` and `.zoom-modal` families on shared radius/shadow/backdrop.

### 2c. Static markup inline-style cleanup
In the static HTML section only (~197 lines): move repeated inline styles
(headings, subtitles, hint text in the Integrations/Tools sections) into small CSS
classes. JS-generated inline styles are left alone.

### 2d. Responsive + readability
- Unify breakpoints on 640px and 900px (the 700px one-off moves to 640px).
- Break the "monster lines" (e.g. line 91's 8 stage-pill rules on one line, minified
  media queries) into readable formatted CSS. No behavior change — formatting only.
- Standardize transitions on `.15s ease`.

## Out of scope
- admin-pbs.html, admin-visa.html, admin-signin.html
- Any server.js change
- Feature/layout redesign, nav restructure
- Replacing `style="display:none"` toggles
- The `console.error/warn` logging (intentional error reporting, kept)

## Error handling / testing
- `npm test` (vitest) must pass.
- Inline JS syntax-checked by extracting the script block and running `node --check`.
- Visual smoke test: run `npm start` and load `/pages/admin.html` to confirm the page
  renders and tabs switch (auth-gated content may be limited locally).

## Risks
- Biggest risk is a CSS value change that subtly breaks a layout. Mitigation: tokens are
  chosen to match the *most common* existing value for each cluster, so most elements
  render identically; only outliers move.
- Second risk: an escAttr/null-guard edit breaking a working handler. Mitigation: edits
  follow the exact pattern already used elsewhere in the same file.

## Deployment
1. Commit all work to branch `worktree-admin-dashboard-cleanup` (worktree).
2. Push branch to origin — GitHub + Vercel git integration produces a preview build.
3. Run an explicit preview deploy (`vercel`, not `vercel --prod`) for a direct URL.
4. Do NOT merge to main; do NOT promote to production.

## Addendum (2026-06-12, after preview feedback): admin/user host separation

User feedback: clicking the Vercel preview lands on the GP onboarding, not the admin
dashboard; admin and user sides must be completely separate.

Root cause: admin access is host-gated via `ADMIN_ALLOWED_HOSTS`; preview hostnames are
never in that allowlist, so admin pages/APIs 404 on previews and `/` always redirects to
the user app. Separation was also one-way: dedicated admin hosts still served the entire
GP app.

Design:
1. **`preview` host scope** — `getAdminHostScope()` returns `'preview'` when
   `process.env.VERCEL_ENV === 'preview'` (checked after the explicit host allowlists).
   `doesAdminRoleMatchHost` treats `preview` like `admin`/`local` (admin, staff, and
   super_admin roles allowed). Admin login is still required; production deployments run
   with `VERCEL_ENV=production` so this scope can never apply to live domains. Preview
   deployments serve BOTH sides (they exist for testing).
2. **Host-aware root** — `/` redirects to `/pages/admin` on `admin`/`super_admin`/
   `preview` scopes, `/pages/index` otherwise. Local dev (`local` scope) keeps the user
   app at root.
3. **Two-way separation on dedicated admin hosts** (`admin`/`super_admin` scopes only) —
   any page navigation (`.html` routes, blog) that is not one of the five admin pages
   redirects to `/pages/admin-signin` UNLESS a user session exists. The user-session
   exception is required by impersonation: `/api/admin/impersonate` sets a user session
   cookie on the admin host (cookies are host-scoped, so the impersonated app must run
   there). Assets (`/js`, `/media`, `/documents`, `sw.js`) and APIs are not page
   navigations and are unaffected.

Out of scope: moving impersonation to the user domain (requires a cross-host token
handoff), Vercel Deployment Protection settings, and ensuring preview-environment env
vars (ADMIN_EMAILS / AUTH_SECRET / Supabase) exist — flagged to the user instead.
