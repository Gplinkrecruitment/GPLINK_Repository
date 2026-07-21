# Practice flow test run — email → placement (2026-07-22)

A live production rehearsal of the practice pipeline, run by the owner with a
session verifying each hop against the database and public APIs.

This is the second run. The first (Erina Medical Centre, 17 Jul) reached
"approved job on the live board" and stopped there. Nothing has ever been taken
through the GP-apply → interview → placement half.

## Split into two halves — and why

A concurrent session is executing
`docs/superpowers/plans/2026-07-21-career-interview-contract-pipeline.md`
(16 tasks, 77 steps) in the `career-withdraw-offer-flow` worktree. Its **Task 5**
changes what acceptance *means*:

- **Today:** GP accepts an offer → `finalizeInAppPlacement` runs → placement created immediately.
- **After:** GP accepts → interview booked only. Placement happens later, after a
  contract is uploaded, AI-reviewed, sent to the GP and signed
  (new `career_contracts` table, Phase 2 / Tasks 8–16).

Its Task 7 reverts a real accidental production placement (Helen's) caused by
today's behaviour, and touches rows the test GP is entangled in.

**Therefore:** run stages 1–3 now (untouched by that plan), stop *before* the job
goes public, and run stages 4–7 after the contract pipeline ships — rewriting the
back half of this sheet to match the new behaviour.

## Participants

| Role | Identity | Notes |
|---|---|---|
| Practice | created fresh in the CEO dashboard | contact email chosen by the owner at creation |
| Test GP | `smithmiller1234@gmail.com` — Smith Miller, UK-registered, already exists (created 2026-05-01) | UK registration ⇒ not Australia-trained ⇒ exercises the DPA gate |
| Owner | drives every dashboard/form/email click | the session cannot authenticate as CEO in prod (local `AUTH_SECRET` ≠ prod) |
| Session | verifies after each hop | reads Supabase + public APIs with the service key |

## Pre-run cleanup — DONE 2026-07-22

Reversible archive, nothing deleted:

- `career_roles` **93105** (stray duplicate Erina job on the throwaway clinic): `approval_status` `pending` → `rejected`.
- `practices` **25be33d6** "Test Practice": `stage` → `archived`.
- `practices` **22ff13f9** "GP Link TEST Clinic (delete me)": `stage` → `archived`.

Verified after: **0** jobs at `approval_status=pending`, **0** practices at
`stage=prospective`. The next prospect and the next pending job are unambiguously
this run's.

**Left deliberately untouched:** `career_roles` **93104** (Erina, approved + live)
carries Helen's withdrawn application `7d2e320f`, which the concurrent session's
withdraw work depends on.

## Stage 1 — Prospect + intake email

**Owner:** CEO dashboard → Practices → **Add practice**. Name it disposably
(e.g. "Bayside Test Clinic (GP Link QA)"). Set the contact email to an inbox you
can open. Save, then on the new card click **Resend intake email**.

Note: "Add practice" defaults to `prospective` as of `6e95945` — this run is also
the first live exercise of that fix.

**Verify:** row `stage=prospective`; `intake_token` persisted (column or
`metadata.intake_token`); Resend accepted the send; email lands in the inbox.

## Stage 2 — Intake form + e-signature

**Owner:** open the emailed link (`/pages/practice-intake?token=…`), complete the
5 steps, sign. **Use an address inside a DPA** so the job is DPA-eligible and the
UK-registered test GP can see it.

**Verify:** `stage=active`; `agreement_status=signed`; signed PDF in Storage;
`practice_groups` row; new `career_roles` row with `posted_by=practice_intake`,
`approval_status=pending`, `is_active=false`, a `masked_title`, and `dpa=true`.

## Stage 3 — AI write-up review (STOP BEFORE APPROVING)

**Owner:** CEO → Jobs. The pending job sorts to the top (`e0ff2df`). Open it,
click **Regenerate** for the AI write-up, read it.

**Verify:** write-up carries **no** practice name, doctor name or street address —
masking is applied at generation *and* re-applied on serve. Check `aiAbout`,
`aiHighlights` and `aiPerks` are populated.

> **Do not click Approve.** Approving publishes the job to the live board, where a
> real GP could apply to a fake practice. The job stays `pending` until the back
> half is ready to run.

Known gotcha: editing or regenerating the write-up and then approving without
saving loses the edits — there is no autosave.

## Stages 4–7 — deferred

To be rewritten once the contract pipeline ships. Under the new behaviour the
shape becomes: GP applies → candidate submitted → practice approves → identity
revealed → **interview** → practice extends offer → contract uploaded →
AI-reviewed → CEO submits → GP signs → placement secured.

## Known limitations for this run

1. **Facebook front door is off** — `FB_LEAD_WEBHOOK_SECRET` and
   `FB_LEAD_VERIFY_TOKEN` are unset in Vercel, so the real ad-lead hop is skipped;
   the run starts at "Add practice".
2. **Zoom may be unconfigured** in prod. It degrades gracefully —
   `createZoomInterviewMeeting` returns empty rather than storing a dead link, and
   `resolveInterviewJoinUrl` falls back to `INTERVIEW_MEETING_URL`. Not a blocker.
3. **hello@ is deliberately never auto-read**, so a practice replying to the intake
   email is not picked up by anything. Expected, not a bug.
4. **No CEO authentication from the session** — every dashboard action is the
   owner's; the session verifies via the database and public APIs and never claims
   a step passed without checking it.
