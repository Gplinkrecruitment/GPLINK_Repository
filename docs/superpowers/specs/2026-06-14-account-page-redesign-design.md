# GP-side Account Page Redesign + Account Deletion / Reinstatement

**Date:** 2026-06-14
**Branch:** `worktree-account-redesign` → deploy to `main`
**Status:** Approved design (mockups iterated with product owner)

## 1. Goal

Redesign the doctor-facing account page (`pages/account.html`) so it looks polished and intentional instead of "vibe-coded", remove redundant elements, and add an **in-app account deletion flow** required for Apple App Store acceptance (Guideline 5.1.1(v)) — with a soft-delete + reinstatement model and a CEO escalation when an active-placement doctor deletes.

## 2. Visual design

Locked via iterated mockups. The system:

- **Hero:** dark navy gradient `linear-gradient(135deg,#0f172a 0%,#1e293b 60%,#1e3a5f 100%)` (matches the live app), vivid brand-blue avatar (`linear-gradient(135deg,#3b82f6,#1d4ed8)`), white name (DM Sans 800), email, and a `% complete` progress bar (gradient `#3b82f6→#2563eb` fill).
- **Brand blue only:** `--blue:#2563eb`, `--blue2:#1d4ed8`. No off-theme colors (no amber/green/purple icon tiles). Red (`#dc2626`) reserved strictly for the destructive delete confirm.
- **Glass cards:** `rgba(255,255,255,.92)`, `1px` bluish border, 20px radius, soft shadow, on a soft blue page background (`radial-gradient(...#dbeafe...) ,#f0f4fa`).
- **Icons:** clean line icons (1.8 stroke, brand blue), **no filled background tiles**.
- **Tabs:** glass pill bar; active tab is a blue gradient pill. Tabs: **Home · Personal · Security · Career** (Career = existing `documents` panel).
- **Buttons (consistent rule):** solid-blue **primary** reserved for true commit actions only (Save details, Set password, destructive confirm uses red `danger`). Everything else (Upload, View, Change photo, Cancel, Forgot password, Sign Out) is **secondary** (white/outline). Upload buttons are identical; an uploaded doc's button relabels to "Replace" (state, not style).
- **Fonts:** DM Sans (UI) + Source Serif 4 (already loaded).

### Responsive

- **Mobile (default, ≤859px):** single column, ~480px max, mobile app-header ("My Account" + bell). Career upload cards **stack 1-per-row**.
- **Desktop (≥860px):** wide hero + desktop shell topbar (logo + Home / My Documents / Support / My Practice / Account). Hero progress moves to the right. Tab bar centered (~560px). **Tab content sits in a calm centered ~680px column** (NOT a cramped 2-col card grid). Career uploads go 2-col.

## 3. Tab content (what changes)

- **Home (slimmed):** the old redundant action-cards that just jumped to other tabs are removed. New Home =
  1. **Account overview** — tappable list (rows: Personal details / Relocation preferences / Career documents) with completion pills (`Complete` soft-blue; `Add` solid-blue), each row jumps to its tab via `data-tab-target`.
  2. **Saved jobs** — existing `savedJobsList` rendering (unchanged behaviour).
  3. **Quick links** — list rows to **My Documents** (`my-documents`) and **My Practice** (`career`). This is where these live on mobile (they are not in the mobile bottom nav).
  - Removed: the "Complete your account check-up" suggestion box and the bulky link-cards.
- **Personal:** Personal Details (first/last name, locked Registration country, phone, registration number) + Relocation Details (city, commence-by date, who's moving, children count) + Save bar. Unchanged fields/IDs.
- **Security:** Email (read-only) + Password & Security (collapsible change-password) + Sign Out + **Delete account** (small grey underlined text link → confirmation modal).
- **Career:** Career Documents (CV + Cover Letter uploads, **no "Employer ready"/"Career intro" chips**) + Profile Photo. Unchanged upload IDs.

### Hard constraint: preserve all JS hooks

`pages/account.html` carries ~900 lines of inline JS. The redesign rewrites the `<style>` block and `<body>` markup/classes but **must preserve every element id and data-attribute** the existing script depends on: `heroName, heroEmail, heroAvatar, heroProgressBar, heroProgressLabel`, all `[data-tab]`/`[data-tab-target]` buttons, `firstName, lastName, specialistCountryDisplay, phone, registrationNumber, cityOfChoice, preferredStartDate, movingParty, childrenMovingCount, childrenMovingField, saveBtn, resetBtn, saveStateText`, `email, securityToggleBtn, securityToggleIcon, securityContent, currentPassword, newPassword, confirmPassword, setPasswordBtn, forgotPasswordBtn, passwordActionStatus, passwordStateText, accountSignOutBtn`, `cvAction, cvInput, cvFileName, cvStatus, cvUpdated, coverLetterAction, coverLetterInput, coverLetterFileName, coverLetterStatus, coverLetterUpdated, changePictureTrigger, profilePhotoInput, docAvatarImg`, `savedJobsList`. The tab-slider element is removed; `switchTab` is adapted to toggle an `.is-active`/`on` class instead of animating a slider.

## 4. Account deletion / reinstatement (backend)

### Model: soft-delete (archive) → reinstate → purge

`active` → **`archived`** (hidden everywhere, 90-day timer, reversible) → **purged** (hard delete after `purge_after`, honoring legal retention).

### 4.1 Database migration

New file `supabase/migrations/20260614120000_account_deletion.sql`:
- `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';`
- `... archived_at TIMESTAMPTZ;`
- `... purge_after TIMESTAMPTZ;`
- `... archived_reason TEXT;`
- Index on `account_status` for the admin list / purge cron.
- (No separate archive table — soft-delete in place.)

Applied to production via `rpc/exec_sql` with the service key (per project convention).

### 4.2 Endpoints (server.js)

- **`POST /api/account/delete`** (auth required): set `account_status='archived'`, `archived_at=now()`, `purge_after=now()+90d`. If the user has an **active placement** (`gp_applications.status='hired'` for their `user_id`), call `_createRegTask(caseId, {...})` with `task_type:'account_deleted_active_placement'`, `priority:'urgent'`, escalated to CEO (`escalated_to = CEO user id`, `status:'escalated'`, `escalated_reason`), titled "Account deleted with active placement — find out why" and naming the practice. Then clear the session cookie (sign out). Returns `{ok:true, purgeAfter}`. Requires a confirmation token/body so it can't be triggered accidentally.
- **`POST /api/account/reinstate`** (called from the login reinstatement prompt; identifies the user by the just-authenticated session OR a short-lived reinstate token): set `account_status='active'`, clear `archived_at/purge_after`, resolve any open deletion task. Returns `{ok:true}`.
- **`POST /api/admin/accounts/:userId/reinstate`** (admin/CEO auth): same reinstatement, callable from the admin archived-accounts list; marks the CEO task resolved.
- **`GET /api/admin/accounts/archived`** (admin/CEO auth): list archived accounts (name, email, archived_at, purge_after, hasActivePlacement) for the admin UI.

### 4.3 Login-time check

In `POST /api/auth/login` (and the session bootstrap that loads the profile), after auth succeeds, look up `account_status`. If `archived`:
- Do **not** establish a normal session. Return a distinct response `{ok:false, archived:true, reinstate:{name, purgeAfter, token}}` (token = short-lived signed token scoped to reinstate this user).
- The sign-in page shows the **reinstatement prompt** (see 4.5).

All normal data queries that list/return users must exclude `account_status='archived'` (matching/search/active counts). Document the key call sites changed.

### 4.4 Purge cron

New cron route (e.g. `GET /api/cron/purge-accounts`, guarded by the existing cron-auth that accepts Vercel system + shared secret): find `account_status='archived' AND purge_after < now()`, and for each: delete `user_profiles` row + Supabase auth user + associated data (saved jobs, uploaded docs, user_state) **except** records under legal retention (active-placement / AHPRA / visa submissions), then log. Registered in `vercel.json` crons (daily). Conservative: only acts well past the window; logs every action; no-op safe.

### 4.5 Sign-in reinstatement prompt (`pages/signin.html`)

When login returns `archived:true`, render a card over the navy login background: "Welcome back, {name}", "scheduled to be permanently deleted", countdown to `purgeAfter`, **Reinstate my account** (primary → `POST /api/account/reinstate` with token → on success, continue normal login) and **Not now** (clears the form, stays signed out).

### 4.6 Admin archived-accounts list (`pages/admin.html`)

A new section/filter "Archived accounts" listing archived users with archived/purge dates and a **Reinstate** button (→ `POST /api/admin/accounts/:userId/reinstate`). Active-placement deletions also surface as the urgent CEO task in the CEO dashboard.

## 5. Out of scope (noted, not built here)

- Harmonizing the app-shell mobile bottom nav vs desktop topbar (My Documents not in mobile bottom nav) — shell-level change, separate task.
- Hard-deleting historical data beyond what the purge cron covers.

## 6. Verification plan

- `node --check` on `server.js` and any edited JS (temp Node).
- Manual review that every preserved id/data-attribute in §3 still exists in the redesigned `account.html`.
- Confirm migration is idempotent (`IF NOT EXISTS`).
- Because the environment cannot run the full server/DB end-to-end, the delete/reinstate/login flows are **statically verified**; product owner should exercise the delete → reinstate path on a **test account** in preview/prod before relying on it. This will be stated plainly on handoff.

## 7. Deploy

Commit on `worktree-account-redesign`, merge to `main`, push `origin/main` (Vercel auto-build via SSH deploy key). Apply the migration to production Supabase via `rpc/exec_sql`.
