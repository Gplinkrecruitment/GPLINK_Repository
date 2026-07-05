# Onboarding Nudge Emails + "Onboarding incomplete" Waitlist Sub-bucket — Design

**Date:** 2026-07-05
**Status:** Approved (design), pending implementation plan
**Branch:** `worktree-onboarding-nudge-waitlist` (branched fresh from `origin/main` @ `352467a`, which already contains the merged PEP waitlist gate)

## Problem / Goal

Two linked problems, both visible in the reported case (GP "Helen"):

1. **She shows as "Unassociated" but hasn't finished onboarding.** In this app "Unassociated" is purely an ATS pipeline label meaning *"this GP has zero job applications"* (`lib/ats-practices.js:149` — `if (!list.length) return 'unassociated'`). Onboarding state is never checked. So a half-signed-up GP with no applications lands in Unassociated even though she isn't a real, contactable candidate yet.
2. **Nothing chases GPs who start onboarding and drop off.** There is no reminder mechanism; a GP who leaves mid-onboarding is simply never contacted again.

We want to:

- Keep GPs who have **not completed onboarding** out of the "Unassociated" pipeline entirely, and instead surface them in the CEO **Waitlist** area under a new **"Onboarding incomplete"** sub-bucket — alongside the existing **"PEP pathway"** sub-bucket. Once they finish onboarding they flow into Unassociated (or their real stage) as normal.
- Send them a sequence of reminder emails from `notifications@mygplink.com.au` after they leave the app without finishing: **immediately (~1h), 24h, 3 days, then weekly for a month, then stop.**
- Each email has a **"Continue where you left off"** button that deep-links to their exact last onboarding step, plus small **"Unsubscribe from these reminders"** text (one click, no login).
- The clock **resets on return**: any fresh activity restarts the sequence from their newest last-active time.
- Emails stop when they complete onboarding (silently — the existing "onboarding complete" email is the only completion message).

## Context this design builds on (already in `origin/main`)

- **PEP waitlist gate (merged `352467a`).** PEP-eligible GPs get `account_status = 'pep_waitlist'`, a `pep_waitlist` table row, and a lock-style `/pages/pep-pathway.html`. The CEO dashboard already renders a single **"Waitlist (PEP pathway)"** section:
  - `renderPepWaitlistSection()` / `renderPepWaitlistBody()` — `pages/ceo-dashboard.html:1832`
  - `loadPepWaitlist()` → `GET /api/ceo/pep-waitlist` — `pages/ceo-dashboard.html:1862`
  - Release action → `POST /api/ceo/pep-waitlist/release`
- **Email sending.** `sendEmail({ to, subject, html, text, from, ... })` — `server.js:24286`; default from is already `notifications@mygplink.com.au`. `sendGpNotificationEmail(userId, subject, title, body, ctaText, ctaUrl, footer)` — `server.js:24527` — is the lifecycle-email pattern (looks up the GP email, personalizes `{{name}}`, renders via `buildCareerEmailHtml`).
- **Cron pattern.** `vercel.json` `crons` array + a `GET /api/cron/<name>` branch in `server.js` guarded by `Authorization: Bearer <CRON_SECRET>`. Template: `GET /api/cron/weekly-sweep` (`server.js:26548`), which already scans stalled GPs and calls `sendStalledReminderEmail`.
- **Onboarding completion signal.** Canonical test: `completed = !!(ob.completedAt || state.gp_onboarding_complete)` (`server.js:25666`); also `user_profiles.onboarding_completed_at` (timestamptz). Last step lives in `user_state.state.gp_onboarding.currentStep` (0–4; `TOTAL_STEPS = 5`, `js/onboarding.js:4`).
- **Last-active proxy.** No `last_login` column. Activity is inferred from `user_state.updatedAt` (written on every onboarding save / `/api/state`) and `registration_cases.last_gp_activity_at`.
- **No unsubscribe infra exists** — this feature ships the first one.

## Scope decisions (confirmed with owner)

- Not-yet-onboarded GPs → shown under **Waitlist → Onboarding incomplete**, removed from Unassociated. (Owner: two-sub-bucket Waitlist.)
- First email approximated by an **hourly** cron (~within 1h of leaving). (Owner.)
- **Reset the clock on each return.** (Owner.)
- **My branch builds the full 2-tab Waitlist shell** (PEP pathway tab is the existing code untouched; Onboarding incomplete tab is new). (Owner.)
- On completion, reminders **stop silently**. (Owner.)

---

## Architecture

Four units, each independently understandable and testable:

### Unit A — `onboarding_reminders` table (new)

One row per GP who has started but not completed onboarding. Source of truth for the email sequence; keeps the hourly cron cheap (indexed query instead of scanning every user).

```sql
CREATE TABLE IF NOT EXISTS onboarding_reminders (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID,                       -- loose, no FK (matches pep_waitlist convention)
  email              TEXT,
  name               TEXT,
  anchor_at          TIMESTAMPTZ,                -- their most-recent "last active"; sequence measured from here
  last_step          SMALLINT,                   -- gp_onboarding.currentStep at last read (for the deep link)
  steps_sent         SMALLINT[]  NOT NULL DEFAULT '{}',  -- which sequence indices already emailed since this anchor
  last_sent_at       TIMESTAMPTZ,
  unsubscribed       BOOLEAN     NOT NULL DEFAULT false,
  unsubscribed_at    TIMESTAMPTZ,
  stopped            BOOLEAN     NOT NULL DEFAULT false,  -- true once completed OR sequence exhausted (>31d)
  stopped_reason     TEXT,                       -- 'completed' | 'exhausted'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_reminders_user ON onboarding_reminders(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onboarding_reminders_active ON onboarding_reminders(stopped, unsubscribed);
-- service-role-only RLS, same DO-block pattern as pep_waitlist (20260705110000).
```

Migration file: `supabase/migrations/20260705130000_onboarding_reminders.sql`. **Not** applied automatically — applied via `rpc/exec_sql` with the service key (repo convention). Local-DB fallback: `dbState.onboardingReminders` keyed by lowercased email.

### Unit B — the reminder engine (pure) + hourly cron (new)

**Pure helper** `lib/onboarding-nudge.js` — no I/O, fully unit-testable:

- `NUDGE_SCHEDULE_MS = [1h, 24h, 72h, 10d, 17d, 24d, 31d]` — inactivity thresholds, index 0..6 (7 emails).
- `nextDueStep({ inactivityMs, stepsSent })` → the lowest index whose threshold `<= inactivityMs` and not in `stepsSent`, or `null`. (Send at most one email per cron run per GP — the earliest unsent due step.)
- `isExhausted({ inactivityMs, stepsSent })` → `true` when index 6 has been sent, or `inactivityMs` exceeds the final threshold and all due steps are sent.
- `copyForStep(index, { name, stepsLeft })` → `{ subject, title, body }` (plain, friendly; slight variation by index — early ones light, later ones "you're almost there / we'll stop reminding you soon").

**Cron** `GET /api/cron/onboarding-nudge` (Bearer-secret guarded), added to `vercel.json` as `{ "path": "/api/cron/onboarding-nudge", "schedule": "0 * * * *" }`. Each run:

1. **Enumerate** GPs eligible for chasing: has an account + started onboarding, `onboarding_completed_at IS NULL` / `gp_onboarding_complete` false, **`account_status = 'active'`** (treat null/empty as active). Chasing only `active` deliberately excludes `pep_waitlist` (PEP-gated), `under_review` (already submitted onboarding → restricted mode, i.e. effectively done), `archived`, and `suspended`. Also exclude admins/VAs (reuse the existing admin-exclusion guard used by `weekly-sweep` / `_ensureRegCase`). For each remaining GP, ensure an `onboarding_reminders` row exists (create on first sight — this backfills existing incomplete GPs like Helen).
2. For each active (non-stopped, non-unsubscribed) row, read the GP's current `last_active` (`user_state.updatedAt`, fallback `last_gp_activity_at`) and `gp_onboarding.currentStep`.
3. **Completed since?** → set `stopped = true, stopped_reason = 'completed'`. (No email.)
4. **Returned since?** If `last_active > anchor_at` → reset `anchor_at = last_active`, `steps_sent = '{}'`, refresh `last_step`.
5. `inactivityMs = now - anchor_at`. `step = nextDueStep(...)`. If `step != null` → send email (Unit D), append to `steps_sent`, set `last_sent_at`.
6. **Exhausted?** → `stopped = true, stopped_reason = 'exhausted'`.

Idempotent: `steps_sent` guarantees no double-send within an anchor window even if the cron runs twice.

> Note on cadence anchoring: because the clock resets on return, "1 month then stop" means one month after the GP's **last** activity. A GP who keeps re-engaging but never finishes keeps getting the sequence (reset each time) — this matches "after they leave the app" and the owner's reset choice. Stop is permanent only once 31 days of continuous inactivity elapse (or they complete).

### Unit C — Waitlist becomes a 2-tab section (CEO dashboard) + Unassociated exclusion

**(c1) Exclude not-onboarded from the funnel.** Where the candidate pipeline bucket is assigned (`server.js:~48597` and the local-DB path `~48561`, plus `pipeline-summary` `~48633`), add a guard *before* `bucketForApps`: if the GP's onboarding is not complete, they are **not** assigned `unassociated` — they are excluded from the normal funnel counts and candidate rows, and instead counted under the Waitlist "Onboarding incomplete" sub-bucket. Reuse the same `completed` test as `server.js:25666`. (PEP-gated GPs are already excluded upstream by their `account_status` gate.)

**(c2) New read endpoint** `GET /api/ceo/onboarding-incomplete` — returns `{ ok, summary: { count }, items: [{ user_id, name, email, phone, country, last_step, last_step_label, last_active_at, inactivity_days, emails_sent, next_email_eta, unsubscribed, stopped }] }`. Data joins `onboarding_reminders` + `user_profiles` + last-active. Read-only; mirrors the shape of `/api/ceo/pep-waitlist`.

**(c3) 2-tab Waitlist shell.** Rename the existing section from **"Waitlist (PEP pathway)"** to **"Waitlist"** with two tabs inside one `sectionCard`:
- **PEP pathway** — the existing `renderPepWaitlistBody` / `loadPepWaitlist` / release action, moved under the tab **unchanged**.
- **Onboarding incomplete** — new `renderOnboardingIncompleteBody` / `loadOnboardingIncomplete` → `/api/ceo/onboarding-incomplete`. Each row shows name, email, phone, country, last step reached, days inactive, emails sent so far, next-email ETA, and an unsubscribed/stopped badge. Tab header shows counts, e.g. `PEP pathway (3) · Onboarding incomplete (12)`.
- Optional per-row action (nice-to-have, include if cheap): **"Stop reminders"** → sets `stopped` (admin override). Not required for v1.

### Unit D — the reminder email + resume deep-link + unsubscribe (new)

**Email** built on the existing `sendEmail` / `buildCareerEmailHtml` path, from `notifications@mygplink.com.au` (name "GP Link"):
- Subject/body from `copyForStep(index, ...)`. Plain and warm: "You're almost there — X steps left to finish setting up your GP Link account."
- **CTA button "Continue where you left off"** → `https://app.mygplink.com.au/login?next=%2Fpages%2Fonboarding.html%3Fstep%3D<lastStep>` (URL-encoded; survives the sign-in bounce via the existing `next` → `route` deep-link chain). `<lastStep>` comes from the server-side `gp_onboarding.currentStep`.
- **Footer:** small text `Unsubscribe from these reminders` → `https://app.mygplink.com.au/api/onboarding-reminders/unsubscribe?u=<userId>&t=<hmac>`.

**Deep-link fix in `js/onboarding.js`.** Today `loadState()` restores `currentStep` from **localStorage only** (`js/onboarding.js:76`), so a cross-device click lands at step 0. Add: on init, if `?step=N` is present and `0 <= N < TOTAL_STEPS`, set `currentStep = N` (after auth resolves). `validateStep` still gates forward progress, so this only controls which step is shown — safe. Bump the onboarding cache-buster.

**Unsubscribe endpoint** `GET /api/onboarding-reminders/unsubscribe?u=<userId>&t=<hmac>` — **no login required** (they're logged out in email). `t = HMAC-SHA256(userId, secret)` where `secret` = a dedicated `ONBOARDING_UNSUB_SECRET` (fall back to `AUTH_SECRET`). On valid token: set `unsubscribed = true, unsubscribed_at = now` on their row and return a tiny styled confirmation page ("You won't get onboarding reminders anymore."). Invalid/mismatched token → generic "link expired" page, no user enumeration. A matching `List-Unsubscribe` header is added to the reminder email (`mailto:` + this URL) so Gmail/Apple Mail show a native unsubscribe control too.

## Data flow (end-to-end)

1. GP starts onboarding → `POST /api/onboarding/save` writes `gp_onboarding` (incl. `currentStep`) + bumps `user_state.updatedAt`.
2. Hourly cron sees them incomplete → creates/refreshes their `onboarding_reminders` row; after ~1h inactivity sends email #1 from `notifications@`, records step 0.
3. GP ignores it → 24h / 3d / weekly emails fire per schedule; each `steps_sent`-guarded.
4. GP clicks "Continue where you left off" → `/login?next=/pages/onboarding.html?step=3` → signs in → onboarding opens at step 3.
5. GP either **finishes** (`/api/onboarding/complete` sets `gp_onboarding_complete` + `onboarding_completed_at`) → next cron marks row `stopped='completed'`, and they leave "Onboarding incomplete" → enter Unassociated/real stage; **or unsubscribes** → row `unsubscribed=true`, no more emails; **or goes 31d silent** → row `stopped='exhausted'`.
6. CEO dashboard Waitlist → Onboarding incomplete tab lists all active rows with progress; PEP pathway tab unchanged.

## Error handling

- Email not configured (`isEmailConfigured()` false) → cron no-ops that send, logs, does **not** mark the step sent (so it retries next hour). Consistent with existing lifecycle emails.
- Supabase not configured → cron uses local-DB fallback (`dbState.onboardingReminders`), same dual-path as every other feature.
- Send failure (Resend non-200) → do not append to `steps_sent`; retried next run. Cap retries implicitly via the 31-day window.
- Unsubscribe token invalid → generic page, no leak.
- Admin/VA accounts must never get a row (reuse existing exclusion) — guard in enumeration.

## Testing (vitest)

- **`lib/onboarding-nudge.js` (pure):** `nextDueStep` at each boundary (just-before/after 1h, 24h, 72h, 10/17/24/31d); no double-send when step already in `steps_sent`; `isExhausted` true only after index 6 / >31d; reset-on-return clears `steps_sent`; `copyForStep` returns non-empty subject/body and correct "steps left".
- **Unsubscribe token:** valid token flips `unsubscribed`; tampered token rejected; idempotent.
- **Funnel exclusion:** a GP with `gp_onboarding_complete=false` and no apps is **absent** from `/api/ceo/candidates` and from the `unassociated` count in `/api/ceo/pipeline-summary`, and **present** in `/api/ceo/onboarding-incomplete`; completing onboarding moves them.
- **Cron happy path** (mocked send + clock via injected `now`): creates row, sends #1 after 1h, respects reset-on-return, stops on completion. (Cron reads time from an injected/param `now` so tests are deterministic — no `Date.now()` in the pure layer.)
- **Deep link:** onboarding honors a valid `?step=N`, ignores out-of-range.

## Files touched

- **New:** `supabase/migrations/20260705130000_onboarding_reminders.sql`, `lib/onboarding-nudge.js`, `tests/onboarding-nudge.test.js`, `tests/onboarding-incomplete-endpoint.test.js`, `docs/onboarding-nudge-waitlist.md` (ops note).
- **Edit:** `server.js` (cron branch, `/api/ceo/onboarding-incomplete`, `/api/onboarding-reminders/unsubscribe`, funnel-exclusion guard, reminder-send helper), `vercel.json` (cron entry), `pages/ceo-dashboard.html` (2-tab Waitlist), `js/onboarding.js` (`?step=` honor + cache-buster), `CLAUDE.md`/cache-buster conventions as needed.

## Out of scope (YAGNI)

- No live countdown / per-GP send-time customization.
- No global email-preference center — only this feature's one-click unsubscribe.
- No SMS/WhatsApp nudges (email only, as requested).
- No re-subscribe UI (owner can clear `unsubscribed` manually if ever needed).
- The PEP pathway tab's internals are not modified — only relocated under the shared shell.
