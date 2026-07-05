# PEP "Substantially Comparable" Waitlist Gate — Design

**Date:** 2026-07-05
**Status:** Approved (design), pending implementation plan
**Branch:** `worktree-pep-waitlist-gate`

## Problem / Goal

Today, when a GP's specialist qualification is scanned during onboarding and the
certificate date is **before** the expedited-specialist-pathway cutoff, the scan
comes back "Failed / retry" and after repeated failures the account is flagged for
manual RSO review. That is the wrong outcome: a genuine pre-cutoff qualification is
not a bad scan — the doctor simply belongs on the **PEP (Practice Experience Program)
Substantially Comparable pathway**, which we do not facilitate yet.

We want to:

1. Recognise these GPs at onboarding and tell them, clearly, that they qualify for the
   **PEP Substantially Comparable pathway**.
2. Explain we currently only facilitate the **Expedited Specialist Pathway**, but the
   PEP pathway opens **within the next 30 days**.
3. **Gate** them out of the GP Link app entirely until the PEP pathway launches — they
   see only the PEP pathway page, never the app.
4. Offer a **"Notify me when this is available"** button that sends an immediate
   confirmation via **WhatsApp (DoubleTick) + email** and enrols them for the launch
   announcement.
5. Collect these GPs in a new **"Waitlist"** section of the CEO dashboard pipeline, with
   their details and a **PEP pathway indicator**.

## Cutoff dates (unchanged, existing rule)

Per `server.js` (`dateCutoffs` in `verifyQualificationDocument`):

| Country | Specialist certificate | Expedited cutoff (obtained on/after) |
|---------|------------------------|--------------------------------------|
| UK (GB) | MRCGP  | August 2007 |
| Ireland (IE) | MICGP | 2009 |
| New Zealand (NZ) | FRNZCGP | 2010 |

A certificate dated **before** its country's cutoff → PEP candidate.
Primary Medical Degree date is ignored (as today).

## Chosen approach: account-status gate (Option A)

Reuse the app's existing lock mechanism — the same machinery behind the current
`account_status = 'under_review'` restricted mode enforced in `js/auth-guard.js`. Add a
new account state `pep_waitlist`. Once set, the guard redirects the GP to the PEP
pathway page on **every** route, so they never reach the app. When the PEP pathway
launches, one switch lifts the gate for everyone at once.

Rejected: an onboarding-only redirect (Option B) — leaky; a GP with an existing session
or a deep link could slip into the app, violating the "must not display the GP Link app"
requirement.

## Detection (when a GP becomes PEP)

Detection lives in the shared qualification-verification layer
(`verifyQualificationDocument` in `server.js`), so it fires consistently at onboarding
**and** any other place a specialist certificate is processed (e.g. a document re-scan).

A GP is classified PEP **only** when the read is high-confidence — ALL of:

- Document type is the correct **specialist certificate** for the GP's country
  (MRCGP / MICGP / FRNZCGP — not the primary medical degree, not other doc types).
- `nameMatch` is `exact` or `fuzzy` (name matches the account).
- Document is legible.
- A date is clearly parsed **and** is before the country cutoff.

The verification result gains a distinct structured signal (e.g.
`verification.pepEligible = true` with `pepMeta = { country, certType, dateFound,
cutoffDate }`). Anything blurry, wrong-document, or name-mismatch does **not** set this —
it stays on the existing retry / `under_review` flag path, unchanged.

`classifyQualificationOutcome` (`lib/document-pipeline.js`) gains a third outcome branch:
`pep` → set the gate, alongside the existing `approve` and `flag`.

### On detection

- Set the GP account `account_status = 'pep_waitlist'`.
- Upsert a `pep_waitlist` row with their details and PEP metadata.
- Onboarding routes them straight to the PEP pathway page (they do not continue the
  normal flow).

## The PEP pathway page (new)

A new full-screen, lock-style page (served like the other gated states). Content, in
plain friendly language:

- **You qualify for the PEP Substantially Comparable pathway** — because your
  qualification was obtained before the expedited specialist pathway cutoff.
- We currently only facilitate the **Expedited Specialist Pathway**.
- We are opening the app to the **PEP pathway within the next 30 days**.
- Button: **"Notify me when this is available."**

The `js/auth-guard.js` gate redirects any `pep_waitlist` account to this page for every
route, mirroring how `under_review` restricts access today.

The "next 30 days" wording is static copy (no live countdown); editable later.

## Notify Me action

Endpoint (e.g. `POST /api/pep/notify-me`), session-gated to the GP:

- Marks `notify_requested = true`, `notify_requested_at = now` on their `pep_waitlist` row.
- Immediately sends a confirmation via:
  - **WhatsApp** through DoubleTick (`sendWhatsappText` / the existing DoubleTick send
    path in `server.js`).
  - **Email** (existing outbound email mechanism).
  - Copy: "You're on the PEP waitlist — we'll message you the moment the PEP pathway opens."
- **Idempotent:** if `notify_requested` is already true, do not re-send; return the
  confirmed state.
- Page button then renders a confirmed state ("You're on the list ✓").

## CEO dashboard — Waitlist section

A new **"Waitlist"** section in the CEO dashboard pipeline view
(`pages/ceo-dashboard.html`, near `renderPipelineSection`), backed by a new read
endpoint (e.g. `GET /api/ceo/pep-waitlist`).

Each row shows: name, email, phone, country, certificate type + date found, the cutoff
missed, a **PEP pathway badge**, notify-requested status, and date added. A count/summary
sits at the top.

Per-row admin action: **"Release to normal pipeline"** — one click clears the
`pep_waitlist` gate (back to normal `account_status`) and marks the waitlist row
`released = true`. This is the safeguard for any AI misread; it sends no message, it just
unlocks app access.

## Launch (built now, shipped OFF)

A single switch `PEP_PATHWAY_OPEN` (env flag + admin action). When turned on later:

- Lifts the gate for all non-released `pep_waitlist` accounts (they gain normal app
  access).
- Fires the "PEP pathway is now open" announcement by **WhatsApp + email** to every
  waitlist member with `notify_requested = true` (idempotent — records `launch_notified_at`
  so re-running does not double-send).

Ships **off** so nothing goes out prematurely.

## Data model

Reuse `account_status` for the gate. Add a `pep_waitlist` table:

| Column | Notes |
|--------|-------|
| `user_id` | FK to the GP |
| `name`, `email`, `phone`, `country` | snapshot of GP details for the CEO list |
| `cert_type` | MRCGP / MICGP / FRNZCGP |
| `date_found` | date read off the certificate |
| `cutoff_date` | the country cutoff missed |
| `notify_requested` (bool), `notify_requested_at` | Notify Me state |
| `launch_notified_at` | set when the launch broadcast is sent |
| `released` (bool), `released_at` | admin released back to normal pipeline |
| `created_at`, `updated_at` | |

Migration under `supabase/migrations/`, applied to prod via `rpc/exec_sql`.

## Edge cases

- **AI misreads the date** and gates a legitimate expedited GP → admin "Release to normal
  pipeline" restores access instantly. Detection is deliberately high-confidence to
  minimise this.
- **Repeated Notify Me taps** → idempotent, single send.
- **Re-scan outside onboarding** → detection is in the shared layer, so the gate is set
  consistently.
- **Already-released GP re-triggers detection** → do not re-gate a row marked `released`
  (respect the admin override) unless explicitly reset.
- **Launch broadcast re-run** → `launch_notified_at` guards against double-send.

## Testing

- Detection unit tests: genuine pre-cutoff specialist cert (per country) → `pepEligible`;
  blurry / wrong-document / name-mismatch → NOT pep (stays on retry/flag path); primary
  medical degree pre-cutoff → NOT pep.
- Gate: `pep_waitlist` account is redirected to the PEP page on protected routes; normal
  accounts are not.
- Notify Me: first tap records + sends WhatsApp + email; second tap does not re-send.
- Admin release: clears the gate, marks `released`, sends nothing.
- Launch: enrols only `notify_requested` members, broadcasts once, sets
  `launch_notified_at`.

## Out of scope

- The actual PEP pathway workflow (the steps a GP completes once PEP opens). This design
  only covers detection, the gate, the waitlist, and the notify/launch plumbing.
- A live countdown timer for the 30-day window.
