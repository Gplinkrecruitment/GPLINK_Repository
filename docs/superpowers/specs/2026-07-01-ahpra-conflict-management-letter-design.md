# AHPRA Conflict-of-Interest Management Letter — Design Spec

**Date:** 2026-07-01
**Status:** Approved (owner) — ready for implementation plan
**Branch:** `worktree-ahpra-conflict-letter` (based on `origin/main` @ 66f9866)

## 1. Problem & Background

When an SPPA-00 (AHPRA Supervised Practice Plan) names a supervisor who is **also the
practice owner/director**, the AI conflict scan marks `is_conflict = true` (Q7 = YES) on
the `practice_pack_child` `sppa_00` task. The filled SPPA-00 PDF already prints a promise:

> "The supervisor is the practice owner. An email to the AHPRA officer will be sent
> directly explaining how any future potential conflicts of interest will be handled."

**That email is never actually sent or tracked today.** `is_conflict` is only ever read by
the conflict scan (to tick Q7) and the Q7-override endpoint. There is no task, no practice
outreach, and no record that the conflict was disclosed to the assigned AHPRA officer.

Separately, the email-triage system *already* recognises the concept reactively: it has a
`conflict_followup` AHPRA category and a `request_from_practice` response type described as
"Practice conflict management letter / statement". But that path:
- only fires **after** an officer emails asking (never proactively), and
- creates a **generic** `ahpra_correspondence` task **unconditionally**, with no de-dup —
  in fact today a single inbound AHPRA email already spawns BOTH an `ahpra_correspondence`
  task **and** s80 `ahpra_action_item` bundle tasks with no cross-guard (a latent double-up).

## 2. Goal

When a conflict of interest exists and an AHPRA officer is assigned to the case, create a
**single** admin task whose pre-filled email asks the **practice** to email the **assigned
officer** (dynamic per officer) a statement of how the conflict will be managed and that it
**will not impair the supervisor's ability to supervise** — with the practice **CC'ing a GP
Link mailbox** so the system can auto-detect, auto-close, and keep the confirmation on file.

The task must be the **one canonical home** for the conflict response: whichever trigger
fires first (proactive officer-assignment, or reactive officer-request) owns it; the other
attaches to it. **No double-up** with the authorised-correspondent (`ahpra_correspondence` /
s80) flow.

## 3. Non-Goals (out of scope)

- Fixing the *general* `ahpra_correspondence`-vs-`s80` double-up for **non-conflict** emails.
  We only unify the **conflict** path.
- Auto-*sending* the practice email. It is always a **suggested draft the RSO reviews and
  sends** (matches the alt-supervisor-CV pattern; never auto-sent).
- Changing the SPPA-00 Q7 form-fill, the conflict scan, or the Override-Q7 control.
- Chasing/auto-reminding the practice if they don't send. (Could be a later cron, like the
  alt-CV recovery, but not in v1.)

## 4. Trigger

A single idempotent helper **`_ensureAhpraConflictLetter(caseId, opts)`** is the only thing
that creates the task. It is invoked from three entry points, all of which converge on the
same task:

- **(A) Proactive — officer assigned:** in the main Gmail loop, immediately after an
  AHPRA officer is written to the case (`ahpra_officer_email` set), if the case's `sppa_00`
  task has `is_conflict === true`, call the helper.
- **(B) Proactive — conflict set late:** if Q7 is overridden to YES (or the scan completes
  with conflict) on a case that *already* has an `ahpra_officer_email`, call the helper.
  (Covers conflicts confirmed after the officer was already assigned.)
- **(C) Reactive — officer asks:** in `_processAhpraEmail`, when triage
  `category === 'conflict_followup'` (or `response_type === 'request_from_practice'`) on a
  case that has a conflict, call the helper **instead of** creating the generic
  `ahpra_correspondence` task, and attach the officer's inbound email to the task.

`opts` carries the assigned officer (`officerName`, `officerEmail`) and an optional inbound
message reference (for path C) so the officer's request is recorded on the task.

The conflict is read from the SPPA-00 task: `task_type='practice_pack_child'` +
`related_document_key='sppa_00'`, parse `metadata` (string-or-object), check
`metadata.is_conflict === true`.

## 5. The Task

- **New `task_type`: `ahpra_conflict_letter`.** `related_stage = 'ahpra'`,
  `related_document_key = 'sppa_00'`, `status = 'open'`, `priority = 'high'`,
  title `"Conflict of interest — ask practice to email AHPRA officer"`.
- **Metadata** (modelled on `alt_supervisor_cv_request`):
  - `suggested_subject`, `suggested_body` (HTML) — the pre-filled practice email
  - `practice_email`, `practice_contact_name` — the "To"
  - `ahpra_officer_name`, `ahpra_officer_email` — who the practice must write to (dynamic)
  - `cc_mailbox` — the GP Link mailbox the practice should CC (= the case's assigned RSO
    sender mailbox, via `resolveCaseSenderEmail`)
  - `gp_name`, `supervisor_name`, `practice_name` — for the body
  - `officer_request_message_id` (path C only) — the inbound officer email that asked
- **No new columns.** Everything rides on `metadata` + existing task columns.

## 6. De-dup — "one task, not two" (core requirement)

Three layers (the first two copied verbatim from `_ensureAltSupervisorCvRequest`):

1. **In-process lock** `_ahpraConflictLetterInflight[caseId]` — guards against concurrent
   webhook/cron races within a single server process.
2. **Open-task existence check** — `select id from registration_tasks where
   case_id = … and task_type = 'ahpra_conflict_letter' and status != 'completed' limit 1`.
   If one exists, the helper **returns it** (path C attaches the officer email to it) and
   creates nothing new.
3. **Suppression guard in `_processAhpraEmail`** — when the inbound AHPRA email is a
   conflict follow-up (`conflict_followup` / `request_from_practice`) **and** the case has a
   conflict, route to the helper and **skip** the generic `ahpra_correspondence` creation
   for that email. (Without this, "one task" is impossible because `_processAhpraEmail`
   currently creates unconditionally.) Non-conflict emails are untouched.

Net effect: exactly one open `ahpra_conflict_letter` per case, regardless of how many
triggers fire or in what order.

## 7. Auto-Close (because routing = "practice → officer, CC us")

When the practice sends its statement to the officer and CC's our mailbox, that copy lands
in a watched GP Link inbox. A new matcher recognises it and closes the task:

- **Match rule** (`isConflictLetterConfirmation`, a pure function): an inbound email where
  `From` ≈ the case's `practice_email` (or any practice-domain contact on the case) **and**
  (`To` ∪ `Cc`) contains the case's `ahpra_officer_email`. (The CC to us is *why* we
  received it; the To-officer + From-practice is what identifies it.)
- **Action:** find the case by practice sender / officer recipient, locate the open
  `ahpra_conflict_letter` task, set `status = 'completed'`, store the email as a
  `task_document` / `task_message` (the on-file proof), and stamp
  `metadata.confirmed_at` / `confirmed_via = 'practice_cc'`.
- **Idempotent:** re-seeing the same message id does nothing (reuse the existing
  per-message dedup pattern).

Manual fallback: the RSO can still mark the task complete from the card if the practice
forgot to CC us.

## 8. Status Lifecycle

`open` (RSO reviews & sends the practice email) → `waiting_on_practice` (sent; flipped
client-side via `data-ops-flip-status`, same as alt-CV) → `completed` (CC'd copy detected,
or manual). Card rendering is status-gated exactly like `alt_supervisor_cv_request`.

## 9. Suggested Practice Email (template, RSO-editable)

Built by a pure function `buildConflictLetterEmail({ gpName, supervisorName, practiceName,
officerName, officerEmail, ccEmail, rsoSignoffName })` → `{ subject, bodyHtml }`. Subject is
a plain header (not HTML-escaped); body is HTML-escaped. Draft:

> **Subject:** Conflict-of-interest confirmation for Dr {gpName} — please email AHPRA
>
> Dear {practiceContact}, as part of Dr {gpName}'s AHPRA supervised-practice application,
> the SPPA-00 noted that the supervisor, **{supervisorName}**, is also the owner/principal
> of {practiceName}. AHPRA requires a short statement from the practice confirming how this
> potential conflict will be managed and that **it will not impair {supervisorName}'s
> ability to supervise** Dr {gpName}.
>
> Please email this confirmation **directly to the AHPRA officer handling the application —
> {officerName}, {officerEmail}** — and **CC us ({ccEmail})** so we have it on file.
>
> Suggested wording you can adapt: *"Although {supervisorName} is both the supervisor and
> owner/principal of {practiceName}, this will not impair their ability to provide
> appropriate supervision to Dr {gpName}. Any potential conflicts of interest will be
> managed by …"*
>
> Kind regards, {rsoSignoffName} — GP Link Registration Team

## 10. UI

Reuse the existing `.ops-email-composer` card pattern verbatim:
- Add `ahpra_conflict_letter` to `_hasDetailPanel` (admin.html) so the row expands.
- New render fn `renderOpsAhpraConflictLetter(task)` — status-gated (open → composer with
  `data-ops-send-email` + `data-ops-flip-status="waiting_on_practice"`; waiting → read-only
  "sent, awaiting practice"; completed → green "confirmation received"). The `To` defaults
  to the practice; the body carries the officer + CC details.
- Dispatch it in **both** surfaces (Ops Queue + GP-profile Tasks pane) and in **both**
  dashboards (`pages/admin.html` and `pages/ceo-dashboard.html`) for parity.
- The generic `data-ops-send-email` → `/api/admin/email/send` → flip handler needs **no
  change** (sends from the case RSO mailbox via `resolveCaseSenderEmail`).

## 11. Data / Migration

- **`registration_tasks_task_type_check` rebuild (critical):** the live CHECK constraint has
  drifted from the migration files; a new `task_type` whose value isn't in the **live**
  constraint silently fails to insert (the fire-and-forget POST swallows the error). Before
  shipping: read the LIVE constraint via `rpc/exec_sql` (service key), `DROP` it, and
  re-`ADD` it as the union of the live list **plus** `ahpra_conflict_letter`. Add a forward
  migration file too, but the authoritative apply is via `exec_sql` against prod.
- No other schema changes.

## 12. New/Touched Code

- **New** `lib/ahpra-conflict-letter.js` — pure: `buildConflictLetterEmail(...)` +
  `isConflictLetterConfirmation(emailMeta, { practiceEmail, officerEmail })`.
- **`server.js`** — `_ensureAhpraConflictLetter(caseId, opts)` (idempotent helper);
  trigger A (after officer PATCH), trigger B (Q7-override / scan-complete when officer
  exists), trigger C + suppression (in `_processAhpraEmail`); the auto-close matcher in the
  inbound pipeline.
- **`pages/admin.html` + `pages/ceo-dashboard.html`** — `_hasDetailPanel` entry, render fn,
  dispatch in both panes.
- **`supabase/migrations/2026….sql`** — task_type constraint union (mirrors the prod apply).

## 13. Testing (TDD)

Unit tests (pure, no network) written first:
- `buildConflictLetterEmail` — subject not HTML-escaped; body escapes; officer name/email,
  supervisor, GP, practice, CC mailbox all interpolated; sensible defaults for blanks.
- `isConflictLetterConfirmation` — true when From≈practice & officer ∈ To/Cc; false on
  mismatches (wrong sender, officer absent, empty).
- A pure de-dup decision helper if extracted (e.g. `shouldSuppressGenericCorrespondence`).
Plus regression: full `npm test` must stay green (851 tests at base).

Live behaviours that **cannot** be verified from this machine (no Google creds): real
practice→officer CC detection, real outbound send. These mirror existing working paths
(alt-CV send + match) and will be flagged for owner live-test, never faked.

## 14. Rollout

1. Build on `worktree-ahpra-conflict-letter` (TDD, subagent-driven).
2. `npm test` green + `node --check server.js`.
3. Rebuild the prod `registration_tasks_task_type_check` (exec_sql) to include the new type
   **before** the code that inserts it goes live.
4. Commit, push `HEAD:main` (Vercel auto-build), verify deploy READY.
5. Optionally seed Smith's case to demo the new task for the SOP.

## 15. Risks

- **task_type constraint drift** — mitigated by reading the live constraint, not the files.
- **Auto-close false positives/negatives** — the match rule is conservative (needs both
  practice-sender and officer-recipient); manual close is the fallback.
- **Trigger ordering** — conflict usually precedes officer; both proactive triggers (A & B)
  cover either order; the idempotency guard makes repeats safe.
- **439-commit local drift** — already mitigated: building on a worktree based on
  `origin/main`, verifying every symbol against the worktree (not the stale local copy).
