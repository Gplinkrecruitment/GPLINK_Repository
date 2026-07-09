# Design — Live application card + Confirm-your-Zoom-call page

**Date:** 2026-07-09
**Branch base:** `origin/main` (live prod code; local checkout was 184 commits behind — all references below are the live code)
**Author:** Claude Code (background job for owner hello@mygplink.com.au)

## Plain-English summary

Two fixes on the GP's home screen (`pages/index.html`), reported against Helen Wazalski's account:

1. **The "Application Submitted" card** (under *Recent Updates*) is a one-time notification that always says "Application Submitted", shows a green SUCCESS badge, and — when tapped — opens the **Support/Messages** page. It should instead be a **live card that tracks the application's real progress** (submitted → under review → interview offered → offer → practice secured) and tap through to **the right screen for that stage**.

2. **The "Zoom Assistance Call — MyIntealth" card** (under *Your outstanding actions*) taps through to the MyIntealth registration page (which then bounces to the registration **intro** page). It should get a **clearer title** ("Confirm your Zoom call — MyIntealth") and open a **new in-app page** where the GP sees what the call is for and picks/confirms a time, then sees their Zoom link.

**No database migration is required** — every column already exists.

---

## Feature 1 — Live application card in *Recent Updates*

### Current behaviour (the bug)
- The card's data is a static entry in `user_state.state.gp_link_updates`, written once at apply time by `pushCareerNotificationToUser(...)` — shape `{ id, type:'success', title:'Application Submitted', body, ts, category:'career' }`. **It carries no application id.**
- `renderUpdatesFeed()` in `pages/index.html` renders each update as an `<a class="update-item">` and hard-codes `href = type === "action" ? "messages#tab-action" : "messages#tab-updates"`. Because this entry is `type:'success'`, it links to `messages#tab-updates` — the Support/Messages page. That is the "opens the support page" bug.

### Target behaviour
Render a **live career-application card** (one per active application) at the top of *Recent Updates*, computed from the existing list endpoint, and **suppress the old static career notification** so the live card replaces it (not duplicates it).

**Data source:** `GET /api/career/applications` → `{ ok:true, applications:[ … ] }`. Per application the fields we use:
- `id` — application id (used as `?id=` / `?applicationId=`)
- `role.id` — role public id (used as `&role=`)
- `status` — normalized machine key (see enum below)
- `offerPending` — boolean; `true` only when a live, reviewable in-app offer exists
- `statusLabel` / `statusTone` — friendly label + tone (`review|interview|offer|secured`), present for internal-ATS apps; may be absent, so we derive a fallback.

**Dynamic title + badge tone** (derive from `statusLabel`/`statusTone` when present, else from `status`):

| Stage (status keys) | Card title | Badge tone |
|---|---|---|
| `applied`, `submitted`, `reviewing`, `under_review` | "Application under review" (or `statusLabel`) | neutral / review |
| `interview`, `interview_scheduled`, `interview_confirmed`, `shortlisted` | "Interview offered — confirm your time" | interview |
| `offer`/`offer_pending`/`offered` **and** `offerPending===true` | "Offer ready 🎉" | offer |
| `finalising_placement` | "Offer accepted — finalising placement" | offer |
| `hired`, `secured`, `placed`, `placement_secured`, `offer_accepted`, `contract_signed` | "Practice secured" | success/secured |
| `withdrawn`, `not_proceeding`, `rejected` | omit the card (application closed) | — |

**Smart tap target** — mirror the app's own per-row logic in `career.html`'s `buildApplicationRowHtml` so behaviour is consistent app-wide:
1. Secured (`status` in the secured set, or `statusTone==='secured'`, or `id==='placement-by-association'`) → **`career#secured`** (the "My Practice" screen).
2. Offer (`offerPending===true`) → **`offer-review?applicationId=<id>`**.
3. Interview / everything else → **`application-detail?id=<id>&role=<roleId>`** — the progress page, which as of the live code shows the **inline "confirm interview time"** scheduler when an interview is offered and handles the already-booked case. (This is exactly where `career.html`'s "Confirm time →" row CTA already points, which is why we mirror it rather than jumping to the standalone slot page.)

Hrefs use the feed's existing bare style (e.g. `application-detail?id=…&role=…`, `offer-review?applicationId=…`, `career#secured`) so the app-shell bridge resolves them the same way the current update items are resolved. All of these paths are already registered in `js/app-shell.js`.

### Implementation notes (Feature 1)
- Add an async loader on the home page (e.g. `loadLiveApplicationCards()`) that `fetch('/api/career/applications', { credentials:'same-origin' })`, builds the live card(s), and **prepends** them into `#gp-updates-list`. Cap at the few most-relevant applications (e.g. 3) to avoid a wall of cards; if there are more, the existing career page is the full list.
- In `renderUpdatesFeed()`, **filter out** static career-category updates (`category === 'career'`, i.e. the "Application Submitted"-type entries) so the live card supersedes them. Non-career updates (registration, support, etc.) are untouched.
- Build card DOM with `textContent` for any server-derived strings (no `innerHTML` with server data), matching the codebase convention.
- Failure/empty handling: if the fetch fails or returns no applications, render nothing extra and leave the rest of the feed intact (never throw, never blank the feed). No live card for GPs who have not applied.
- Keep the visual style identical to existing `.update-item` / `.update-badge` cards (reuse those classes and the badge-tone classes already defined in `pages/index.html`).

---

## Feature 2 — "Confirm your Zoom call" page

### Current behaviour (the bug)
- The card is a `registration_tasks` row: `task_type='zoom_call'`, `title='Zoom Assistance Call — <MyIntealth|AMC|AHPRA>'`, `status='waiting_on_gp'`, `related_stage=<stage>`.
- `GET /api/gp/outstanding` surfaces it via its generic `waiting_on_gp` branch, setting `deepLink = oaStageLink(t.related_stage)` → `/pages/myinthealth.html`. The app-shell then routes `/pages/myinthealth` through `shouldRouteThroughRegistrationIntro()` → **`/pages/registration-intro.html`** (worsened for this account because `hello@mygplink.com.au` is in the hard-coded `REGISTRATION_INTRO_ALWAYS_EMAILS` allowlist). Net: the card opens the registration intro, not a call-acceptance screen.
- Assistance calls are `scheduled_calls` rows with `meeting_kind='consultation'`. They are booked **only** via an external Calendly link emailed to the GP. **There is no GP-facing page or endpoint for them today** (only career *interviews*, `meeting_kind='interview'`, have GP surfaces).

### Target behaviour — three pieces

**(A) New page `pages/confirm-call.html`** — built from the `pages/secure-interview.html` template (same `<head>`: `native-bridge.js`, the inline early-embed script, `nav-shell-bridge.js`, `auth-guard.js`, `gp-tokens.css`; same single-file inline `<style>` using `--gp-*` tokens; same `showOnly()` state machine; `textContent`-only for server data). It:
- Reads `?stage=` (fallback: latest consultation call for the user; also accept `?token=`/`?id=` if convenient).
- Fetches `GET /api/gp/assistance-call?stage=<stage>`.
- **States:**
  - *Loading* — spinner.
  - *Invite* (`status==='invited'`): title **"Confirm your Zoom call — <Stage>"**; a line for what it's about — the admin's `meeting_reason`, or a stage fallback ("to help you with your MyIntealth registration"); who it's with (assigned RSO name, else "the GP Link team"); and a **"Choose a time"** button that opens the Calendly booking URL in a **new tab** (`<a href="<calendlyBookingUrl>" target="_blank" rel="noopener">`). Calendly **cannot** be iframed/embedded — the site CSP (`frame-src`/`script-src` in `server.js` `SECURITY_HEADERS`) excludes `calendly.com`/`assets.calendly.com`; opening in a new tab is the codebase-wide convention. After opening, the page **polls** `/api/gp/assistance-call` (on window `focus` + a gentle interval, time-boxed) and auto-flips to *Booked* once the webhook marks it booked. Include a manual "Refresh" affordance too.
  - *Booked* (`status==='booked'`): show the confirmed date/time (rendered in the user's local timezone) and duration; a **"Join Zoom"** button **only if** `zoomJoinUrl` is a real `https://` link. If no Zoom link yet, say it will be emailed/appear shortly — **never** a fake link.
  - *None/empty*: "No Zoom call is scheduled right now" + a link back home.
  - *Error / 401*: friendly message; 401 → prompt to sign in again.
- Serving/gating: `serveStatic` serves any `pages/*.html`; `vercel.json` already globs `pages/**`; `auth-guard.js` in the head gates it client-side (same as `secure-interview.html`). No server route allowlist change required.
- Shell registration: add `confirm-call.html` to `js/app-shell.js` (`PAGE_PATHS`, and a nav group — mirror how `secure-interview` is registered) so the deep link from the outstanding-actions card routes cleanly through the shell. (Do **not** add it to `shouldRouteThroughRegistrationIntro`/`REGISTRATION_ENTRY_ROUTE` — being a new path, it is not hijacked to the intro page, which is the point.)

**(B) New endpoint `GET /api/gp/assistance-call?stage=…`** (`server.js`, alongside the other `/api/gp/*` routes). For the authenticated GP, read `scheduled_calls` where `user_id=eq.<me>&meeting_kind=eq.consultation&status=neq.cancelled`, order `created_at.desc`; if `?stage=` given, prefer that stage, else return the most recent. Return:
```json
{ "ok": true, "call": {
  "id", "stage", "stageLabel",
  "status",                // invited | booked | completed
  "meetingReason",         // scheduled_calls.meeting_reason (may be null)
  "calendlyBookingUrl",    // scheduled_calls.calendly_booking_url
  "scheduledAt", "bookedAt", "timezone", "durationMinutes",
  "zoomJoinUrl",           // may be null for consultations
  "rsoName"                // assigned_rso_name, may be null
} }
```
Return `{ ok:true, call:null }` when the GP has no consultation call. Auth: reuse the same GP session resolution the other `/api/gp/*` routes use. The Calendly webhook (`handleCalendlyInviteeCreated`) already patches this row to `status='booked'` + `scheduled_at` + `zoom_join_url` on booking (it does not branch on `meeting_kind`), so the page's polling just works.

**(C) `GET /api/gp/outstanding` — `zoom_call` special-case.** In the branch that currently emits generic `waiting_on_gp` tasks:
- Ensure the task query `select` includes `task_type` (so the branch can detect it).
- For `t.task_type === 'zoom_call'`: set `title = 'Confirm your Zoom call — ' + stageLabel(t.related_stage)` and `deepLink = '/pages/confirm-call.html?stage=' + encodeURIComponent(t.related_stage)`.
- Leave all other `waiting_on_gp` tasks unchanged.
- Once a call is booked, its linked task moves to `status='waiting'` and naturally drops out of `/api/gp/outstanding` — correct, it is no longer "outstanding". The confirm-call page remains reachable directly and shows the booked state.

The admin-side task title string (`'Zoom Assistance Call — …'`) is left as-is (fine for admin/internal views); only the **GP-facing display** is overridden, keeping blast radius small.

---

## Testing
- `npm test` (vitest) must stay green.
- Add targeted tests:
  - `GET /api/gp/assistance-call` — returns the consultation call for a user; returns `call:null` when none; does not leak another user's call; maps fields correctly.
  - `GET /api/gp/outstanding` — a `zoom_call` `waiting_on_gp` task produces title "Confirm your Zoom call — <Stage>" and `deepLink` `/pages/confirm-call.html?stage=<stage>`; a booked call's task does not appear.
  - Feature 1 routing helper — pure function mapping `{status, offerPending, id, role}` → `{title, tone, href}` for the stage matrix above (unit-testable in isolation).
- Follow existing test file patterns under `tests/`.

## Out of scope (YAGNI)
- No admin "propose a specific time" flow (we keep the existing Calendly booking).
- No embedding Calendly (CSP would need weakening).
- No changes to the interview (`meeting_kind='interview'`) surfaces.
- No new DB columns / migration.
- No change to how the static notification is *written* server-side (we suppress it at display and supersede with the live card).

## Shipping
Work in this fresh worktree off `origin/main`; build + tests; commit; push branch; open a **draft PR** for the owner to merge. Do not push to `main` directly from the background job.
