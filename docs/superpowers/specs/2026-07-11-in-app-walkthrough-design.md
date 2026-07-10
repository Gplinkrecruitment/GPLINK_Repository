# In-App Walkthrough — Design Spec

- **Date:** 2026-07-11
- **Status:** Approved for planning
- **Author:** Claude (brainstormed with owner)
- **Topic:** A guided walkthrough that teaches GPs how to navigate and use the app.

---

## 1. Plain-English summary

New GPs open the app and don't always know how to get around, or what each screen is
for. This feature adds two complementary teaching layers:

1. **An upfront "spotlight" tour** — the first time a new GP lands in the app, the screen
   dims and a pointer highlights each item in the bottom menu, one at a time (Home → My
   Practice → Scan → Support → Account), with a **Next** button. It teaches *how to get
   around*. It auto-plays **once** and can be replayed anytime from a **"? Help"** button.

2. **First-visit page mini-tours** — the first time a GP opens each of the five main
   areas, a short **2–3 step** spotlight walks them through the key things on *that* screen.
   It teaches *what each screen does*. Each area teaches itself once, then never repeats.

We remember what each GP has seen, saved to their account so it follows them across
devices. At launch, only **brand-new sign-ups** get the automatic experience — existing
GPs see nothing unexpected but can replay the tour from "? Help".

---

## 2. Goals / non-goals

**Goals**
- Teach navigation (the five main areas) and the purpose of each main screen.
- Zero disruption for existing users at launch.
- One consistent look for every tip and tour step.
- Content (wording) editable in one place without touching the engine.
- Reliable on the app's iframe-shell architecture (see §5).
- Replayable on demand.

**Non-goals (this iteration)**
- Tips on the individual registration stage pages (MyIntealth, AMC, AHPRA, Visa, PBS,
  Commencement) and Documents. Scope is the **five main areas** only. (Future — §10.)
- A/B testing, analytics dashboards, or per-tip completion metrics (basic event logging
  is allowed but not required).
- Video content. This is interactive overlays, not video (existing per-stage video
  cards are unchanged).
- Localisation / multi-language.

---

## 3. The experience in detail

### 3.1 Upfront navigation tour (auto once, replayable)

- **Where:** runs in the **app shell** (the parent that owns the bottom/top nav).
- **When (auto):** the first time a *new* GP lands on the app after finishing signup and
  the app has loaded Home, **if** the tour has not been completed/skipped. Fires after the
  Home page has loaded and per-user state has hydrated (§6), so nothing is highlighted
  before it exists.
- **Steps (mobile bottom nav):**
  1. **Home** — "Your dashboard. See how far along your registration is, anytime."
  2. **My Practice** — "Browse GP roles matched to you and apply."
  3. **Scan** — "Snap a photo of a document and we verify it for you."
  4. **Support** — "Message our team — replies land right here."
  5. **Account** — "Your profile, details and notification settings."
- **Controls:** `Next`, `Back` (from step 2+), `Skip` (dismisses the whole tour), and a
  step counter ("Step 2 of 5"). Completing **or** skipping marks the tour done.
- **Replay:** a **"? Help"** affordance in the shell header replays the tour on demand for
  any user (new or existing). Replay never changes the "done" flag.
- **Copy above is placeholder** and will be finalised with the owner before ship.

### 3.2 First-visit page mini-tours (2–3 steps each)

Runs **inside each page** (same document as the page content — no cross-frame targeting).
Fires on the first visit to that area, once the tour is done and state has hydrated, then
marks that area seen.

| Area | Route / trigger | Mini-tour steps (placeholder copy) |
|---|---|---|
| **Home** | `/pages/index` | 1) Progress tracker — "Every stage sits here; green done, blue current." 2) Next-step card — "Your single next action is always here." |
| **My Practice** | `/pages/career` | 1) Matched role — "Scored against your profile; higher % = better fit." 2) Detail chips — "Billing type, location perks, incentives." 3) Apply button — "Tap View & apply when you're ready." |
| **Support** | `/pages/messages` | 1) Conversation — "Your officer's replies land here." 2) Message box — "Type here to ask anything; we reply within a day." |
| **Account** | `/pages/account` | 1) Profile — "Your key details at a glance." 2) Settings — "Update info, notifications and privacy here." |
| **Scan** | Scan camera modal (`js/qualification-scan.js`) | 1) Viewfinder — "Snap a photo of any document." 2) "We read and verify it automatically, then file it." |

Notes:
- **Home** first-visit tip is intentionally suppressed on the *very first* Home view
  (the tour is playing there). Because it only fires once the tour is done, it naturally
  appears on a later return to Home — spacing the two out so a new GP never gets two
  overlays back-to-back. (See sequencing, §6.)
- **Scan** is an action (camera modal), not a route. Its mini-tour hooks the first open
  of the scan modal. This is the fiddliest of the five; if modal integration proves
  costly, the fallback is a **single tip** for Scan (documented risk).

---

## 4. Content ownership

All step definitions (selectors + titles + body copy) for both the tour and every page
mini-tour live in **one file** (`js/gp-walkthrough.js`, §5) as plain data objects. The
owner can reword any step by editing text in that one file — no engine changes. Copy is
written in plain, friendly language (per project communication convention).

---

## 5. Architecture

Two well-bounded units, plus a state helper.

### 5.1 `js/gp-coach.js` (NEW) — the overlay engine

A small, dependency-free module. One job: given a target element and a step (or a sequence
of steps), draw the dim + spotlight + anchored tooltip and drive Next/Back/Skip.

**Public interface (used by consumers):**
- `gpCoach.run(steps, options)` — run a sequence; resolves when finished/skipped.
  - `steps`: `[{ target, title, body }]` where `target` is a selector or element.
  - `options`: `{ onDone, onSkip, labelPrefix }`.
- `gpCoach.isActive()` — true while an overlay is showing (so consumers don't stack).

**Responsibilities:**
- Spotlight via a box-shadow cutout; tooltip anchored above/below the target with an arrow.
- Scroll the target into view before highlighting; reposition on scroll/resize.
- Block interaction with the underlying UI except the tooltip controls.
- Accessibility: tooltip `role="dialog"`, `aria-live` step announcements, `Esc`=skip,
  `Enter`=next, focus moved to the tooltip and restored on close.
- Respect `prefers-reduced-motion` (no slide animation when set).
- Self-contained styles injected once, using `--gp-*` design tokens for a native look.

**Testability:** pure geometry/logic (e.g. `computePlacement(targetRect, tipSize,
viewport)`, above/below decision, clamping) is exported for unit tests.

### 5.2 `js/gp-walkthrough.js` (NEW) — content + triggers

Loaded by **both** the shell and every in-scope page. On load it detects its context and
wires up the right behaviour:

- **In the shell:** registers the auto-tour trigger (after Home load + state hydrate,
  gated on `!tourDone`) and wires the "? Help" replay control. Owns the tour step data.
- **In a page:** looks up this page's mini-tour by route, and — once state has hydrated
  and `tourDone && !tips[thisArea]` — runs it via `gpCoach`, then marks the area seen.
- Owns **all** step content (tour + every page mini-tour) as data.
- Guards: never starts if `gpCoach.isActive()`, if another known modal is open, or while
  the account is in a limited mode (`under_review`, `pep_waitlist`); defers instead.

### 5.3 `js/gp-walkthrough-state.js` (NEW, tiny) — per-user memory

Thin wrapper around the one synced state key (§6): `get()`, `isTourDone()`,
`isTipSeen(area)`, `markTourDone()`, `markTipSeen(area)`, `resetAll()`. Parses/serialises
the JSON blob and writes through `localStorage` (which auto-syncs — §6). Shared by the
shell and pages so the read/write shape is defined in exactly one place. (May be folded
into `gp-walkthrough.js` if that stays small; kept separate here for clarity/testing.)

### 5.4 Edits to existing files

- `js/state-sync.js` — add `gp_walkthrough_state` to the `STATE_KEYS` whitelist so the
  flag syncs to Supabase and follows the user across devices.
- `pages/app-shell.html` — load `gp-coach.js` + `gp-walkthrough.js`; add the "? Help"
  control to the shell header.
- `pages/index.html`, `pages/career.html`, `pages/messages.html`, `pages/account.html` —
  load `gp-coach.js` + `gp-walkthrough.js` (with `?v=YYYYMMDD` cache-busters).
- `js/qualification-scan.js` — on first open of the scan modal, trigger the Scan mini-tour.

### 5.5 Why this shape (the iframe consideration)

The app loads each page inside an `<iframe>` shell. Rather than have one tour reach across
the frame boundary to highlight elements inside the iframe (fragile: timing, coordinate
translation, scroll), we split by ownership:

- The **tour** targets only **shell-owned** chrome (the nav) — same document, rock-solid.
- Each **page mini-tour** targets only **its own** elements — same document, rock-solid.

Both use the identical engine, so the split is invisible to the GP. No new cross-frame
message channel is introduced.

---

## 6. State, persistence & sequencing

### 6.1 The state blob

One synced key, `gp_walkthrough_state`, holding JSON:

```json
{ "tourDone": false,
  "tips": { "home": false, "practice": false, "support": false, "account": false, "scan": false } }
```

- Stored in `localStorage`; because the key is in `STATE_KEYS`, writes auto-push to
  `/api/state` (Supabase) and hydrate back on load. Reads happen **after** the
  `gp-state-hydrated` event to avoid the known stale-empty first-paint race.
- A missing/empty blob is treated as all-`false` (a fresh new user).

### 6.2 Fire conditions

- **Tour (shell):** `!state.tourDone` → run once → on finish/skip `markTourDone()`.
- **Page mini-tour:** `state.tourDone && !state.tips[area]` → run → `markTipSeen(area)`.

The `tourDone` gate is what sequences the two layers: a brand-new GP sees the tour first
(page tips suppressed until it's done), then page tips appear as they explore. Home's tip,
suppressed during the tour, surfaces on a later Home visit.

### 6.3 Replay

- **"? Help" (shell header):** replays the tour without altering flags.
- **Account → "Show me around again" (nice-to-have):** `resetAll()` so the whole
  experience (tour + all page tips) plays fresh as the user navigates. Lower priority;
  include if cheap.

---

## 7. Rollout — new sign-ups only, zero disruption

Because a missing blob = fresh user, the only thing needed to spare existing users is a
**one-time backfill** at launch: set every existing user's `gp_walkthrough_state` to the
**all-seen** value (`tourDone: true`, every tip `true`). Then:

- **Existing GPs:** nothing auto-fires. They can still replay via "? Help".
- **New GPs (blob absent):** get the full tour + page mini-tours.

The backfill is a one-time server-side pass over existing users' synced-state records,
run once at launch (exact table/mechanism confirmed during implementation against how
`/api/state` persists state). New accounts created after the backfill are unaffected and
get the full experience.

---

## 8. Edge cases & guards

- **Limited account modes** (`under_review`, `pep_waitlist`): suppress auto tour and page
  tips (access is restricted; highlighting locked areas would confuse). Resume when normal.
- **Another overlay open** (onboarding wizard, scan in progress, qualification review,
  doc modals): defer — never stack two overlays.
- **Target missing / not yet rendered:** skip that step gracefully (don't block the
  sequence or throw).
- **Very small screens / long copy:** tooltip clamps within the viewport; target scrolls
  into view first.
- **Desktop layout:** the top nav differs from mobile (no Scan tab; has Documents). The
  tour targets whichever nav is visible and skips the Scan step when no Scan control is
  present. The app is mobile-first; desktop is handled gracefully, not optimised.
- **Rapid navigation / double-fire:** a page mini-tour won't start if one is already
  active or already marked seen mid-session.

---

## 9. Testing

**Automated (vitest):**
- `computePlacement()` and clamping in `gp-coach.js` (pure functions).
- State helper: parse/serialise, default-empty handling, `markTourDone`/`markTipSeen`,
  `resetAll`.
- Route → area mapping (`/pages/career` → `practice`, etc.).
- Fire-condition logic: `shouldRunTour(state)`, `shouldRunTip(state, area)`.
- Backfill transform: existing blob → all-seen blob.

**Manual browser checklist:**
- New-user path: tour auto-plays on first Home; Next/Back/Skip; step counter; completing
  and skipping both mark done and don't re-fire.
- Each area's mini-tour fires once on first visit and not again.
- Home tip appears on return, not stacked on the tour.
- "? Help" replays the tour.
- Existing-user (backfilled) path: nothing auto-fires; "? Help" still works.
- Cross-device: complete on one device, confirm no re-fire on another (state sync).
- Reduced-motion and keyboard-only pass.

---

## 10. Out of scope / future

- Mini-tours on the registration stage pages (MyIntealth…Commencement) and Documents —
  the natural next iteration; the engine and state model already support it (add areas
  to the blob + content to `gp-walkthrough.js`).
- Analytics on tour/tip completion and drop-off.
- Contextual "what's new" tips when features change.
- Owner-editable copy via an admin screen (currently code-edited in one file).

---

## 11. Files touched (summary)

| File | Change |
|---|---|
| `js/gp-coach.js` | **NEW** — overlay/spotlight engine |
| `js/gp-walkthrough.js` | **NEW** — all content + triggers (shell + pages) |
| `js/gp-walkthrough-state.js` | **NEW** — per-user state helper |
| `js/state-sync.js` | add `gp_walkthrough_state` to `STATE_KEYS` |
| `pages/app-shell.html` | load scripts; add "? Help" control |
| `pages/index.html` / `career.html` / `messages.html` / `account.html` | load scripts |
| `js/qualification-scan.js` | trigger Scan mini-tour on first modal open |
| Backfill (one-time) | seed existing users' state to all-seen at launch |
