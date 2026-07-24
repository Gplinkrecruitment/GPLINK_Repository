# Post-consultation signup nudge + account backfill — design

**Date:** 2026-07-25
**Author:** Claude (with GP Link owner)
**Status:** Approved for build

## Problem

A doctor who books a consultation but never creates a GP Link account is lost — and if
they *do* sign up later with the same email, their consultation (and its AI summary) does
not attach to the new account. Two gaps:

1. **No signup nudge for direct bookers.** The existing consult-nudge cron only nudges
   *qualified* leads (`qualified === true`). Direct Calendly bookers ("Booked direct, never
   screened", e.g. farazsonde88@gmail.com) are `qualified: false`, so they get **nothing** —
   even though booking a call is the strongest intent signal there is.
2. **No account linking.** A pre-account consultation lives on a `scheduled_calls` row with
   `user_id = NULL` / `case_id = NULL`. The GP file reads meetings by `case_id`, and signup
   never reconciles by email, so the call + summary never appear on the new account.

## Goals

- After **any** consultation booking (screened OR direct), send a persuasive signup-nudge
  email sequence to bookers with no account, stopping the instant they sign up.
- Sequence: touch 1 right after booking → touch 2 after the call → weekly for ~1 month
  (touches 3–5). Rich, tactic-driven copy (progress/sunk-cost, scarcity, social proof, loss
  aversion, personalisation, one CTA), varied per touch.
- On verified signup, **backfill**: attach any prior direct booking (+ its AI summary) to the
  new account by matching the verified email.
- Reuse existing infra (consult-nudge cron, marketing unsubscribe token, email suppression).
  No new cron.

## Non-goals

- Changing the `not_booked` sequence (untouched).
- Nudging leads who were screened and **failed** (`screened_out` stays excluded).
- A truly same-second touch-1 (hourly cron ⇒ within ~1h of booking; acceptable for v1).

## Design

### 1. Extend `booked_no_signup` (lib/consult-lead.js — pure)

- Grow the schedule from `[3d, 7d]` to **5 steps** with per-step anchors:
  | step | anchor | offset | meaning |
  |------|--------|--------|---------|
  | 0 | booked_at | 0 | right after booking |
  | 1 | call_at (scheduled_at; fallback booked_at) | +20h | day after the call |
  | 2 | call_at | +7d | week 1 |
  | 3 | call_at | +14d | week 2 |
  | 4 | call_at | +21d | week 3 (final) |
- `booked_no_signup` schedule entries become `{ anchor: 'booked'|'call', after: ms }`.
  `not_booked` stays a plain `[ms, ms]` array. `nextConsultNudge` / `isConsultExhausted`
  handle both shapes; `nextConsultNudge` gains a `callAtMs` input for the 'call' anchor.
- **Relax the qualified gate for the booked path only:** in `nextConsultNudge`, the
  `qualified === false → null` short-circuit applies to `not_booked` only. Booked leads are
  nudged regardless of `qualified`, but still respect `stopped`/`unsubscribed`/`screened_out`.

### 2. Rich email copy (lib/booker-nudge-email.js — pure, new)

- `buildBookerNudgeEmail(step, { displayName, firstName, goalSummary, signupUrl, unsubscribeUrl })`
  → `{ subject, bodyHtml }` for steps 0–4, matching the approved mockups
  (`docs/mockups/direct-booker-signup-nudge-email.html` = step 0;
  `direct-booker-nudge-sequence.html` = steps 1–4). Email-safe inline HTML.
- Rendered through the existing `buildCareerEmailHtml({ bodyHtml, footer })` shell so header/
  footer/brand stay consistent; footer carries the marketing unsubscribe link.

### 3. Cron wiring (server.js `/api/cron/consult-nudge`)

- Relax the cron's `qualified !== true` skip so it applies to `not_booked` only (booked leads
  proceed). Keep the `stopped`/`screened_out` skips.
- Pass `callAtMs` (from `consult.call_at`) into `nextConsultNudge`.
- For `booked_no_signup` sends, route through `buildBookerNudgeEmail` (rich); `not_booked`
  keeps the existing plain copy. Same `category:'marketing'` send (suppression + List-Unsub),
  same nudge-recording + stop-on-signup logic.

### 4. Booking trigger (server.js)

- At booking capture, set `metadata.consult.call_at = scheduled_at` on the lead (both the
  direct path `captureCalendlyDirectBookerLead` and the screened `/booked` path) so the
  'call' anchor has a time. `call_booked` / `call_booked_at` already set today.
- No inline touch-1 send (cron owns step 0, fires within the hour).

### 5. Backfill on verified signup (server.js)

- `backfillPriorConsultationsForUser(userId, email)`: find `scheduled_calls` where
  `invitee_email = email` AND `user_id IS NULL` AND `meeting_kind = consultation` AND
  `status != cancelled`; PATCH `user_id` + the GP's `case_id` onto them so the call +
  `meeting_summary` surface on the GP file. Idempotent (once linked the row no longer matches
  `user_id IS NULL`).
- **Authorization = authenticated-as-email.** This app uses *soft* verification (users are
  auto-logged-in before confirming), so a hard `email_confirmed_at` gate would rarely fire and
  break the feature. Instead, run it from the **signup** and **login** paths (chained after
  `_ensureRegCase` so the case exists), keyed on the account's own session email — holding that
  session IS the authorization. Only unlinked null-user consultations are touched. The nudge
  sequence stops separately (cron sees the account exists ⇒ stamps `converted`).

### Stop conditions (unchanged mechanism)

Account exists (email in auth) → `stopped: 'signed_up'`, status `converted`. Unsubscribe →
`stopped: 'unsubscribed'`. All 5 sent → `stopped: 'exhausted'`.

## Testing

- Pure: `nextConsultNudge` 5-step booked schedule with both anchors; qualified-gate relaxed
  for booked but not `not_booked`; `screened_out` still excluded; `isConsultExhausted` at 5;
  `not_booked` behaviour pinned unchanged.
- Email builder: all 5 steps return subject + bodyHtml; personalisation interpolated; unsub
  link present; no unescaped name.
- Backfill: links direct bookings by email; skips when unverified; idempotent.
- Full `vitest run` green before ship.

## Rollout

Ship to main (auto-deploy). The extended sequence + relaxed gate go live with the next
consult-nudge cron run; backfill runs on the next verified login/signup.
