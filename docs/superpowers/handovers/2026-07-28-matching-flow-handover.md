# Handover — AI matching flow (2026-07-26 → 2026-07-28)

**Status: everything below is LIVE in production.** Last verified deploy:
`7f353e0`, confirmed via `/api/health` (see "Verifying a deploy").

Read this before touching the matching flow, `gp_applications.status`, the
careers page, or the post-interview path.

---

## 1. The single most important lesson

**Fixing one layer is never enough — the doctor-facing status is derived three
times over.** The same bug ("a match from our side shows as an application the
doctor submitted") had to be fixed in four separate places, and each partial fix
looked identical on screen:

| Layer | What it was doing | Fixed by |
|---|---|---|
| DB column | `gp_applications.status` defaults to `'applied'`; the shortlist insert never set it | `status: 'shortlisted'` on the shortlist insert (`server.js`, `msInsertRow`) |
| Existing rows | rows created before the fix kept the old value | one-off PATCH (see §5) |
| Server mapper | `buildInternalCareerStatusPresentation` had no `shortlisted` branch → fell through to `{status:'applied', statusLabel:'Application submitted'}` | added a `matched` branch |
| Client | careers card + tap target both assumed "application" | MATCHED ribbon; taps route to the practice page |

If a doctor-facing screen says something untrue about an application, **check
the mapper before the database.** The stored column is not what reaches the UI.

## 2. Flow as it now stands

```
We shortlist on the Matching board
  → status 'shortlisted', ats_stage 'shortlisted', revealed TRUE, 5-day expiry
  → practice identity is revealed AT MATCH TIME (owner call — they cannot judge
    a match without knowing who it is). Do not re-gate this.
  → match email sent (has "Accept this match" + "See full practice profile")

Doctor accepts → status + ats_stage 'applied', match_outcome 'accepted'
  → creates a MANUAL VA task "Submit <GP> to practice"
    (practice_submission_status 'pending_va_submission')
  → deliberately NOT auto-submitted — a human checks first (owner call 2026-07-28)
Doctor declines → ats_stage 'not_proceeding', match_outcome 'declined'

Staff submit → 'submitted_to_practice', practice gets the intro email
Practice accepts → ats_stage 'interview'  ← NOT 'offer'
Practice turns down → application CLOSES, doctor emailed, practice hidden (§4)

Interview booked from the practice's availability windows → interview happens
Zoom meeting.ended webhook → stamps 'interview_completed' + emails the practice
  a decision request (token-authed accept/decline links)
Practice not proceeding → closes, warm note to the doctor
Practice extends offer → contract upload → AI review → CEO approval
  → /api/ceo/contract/decision → ats_stage 'offer'  ← the ONLY legitimate 'offer'
  → doctor signs → hired
```

**`'offer'` means a real contract offer, nothing else.** Practice acceptance is
an *interview invitation* — the record it creates literally has
`notes: "Practice accepted — interview invitation"`.

## 3. Contract flow (AI + admin gates)

1. Practice uploads → `career_contracts` row, `uploaded`.
2. `aiReviewCareerContract` runs automatically; writes `ai_review` +
   `terms_context` (a snapshot of what it compared against, so a human can audit
   the verdict rather than trust it).
3. A human must approve. `uploaded` / `changes_requested` are flagged for CEO
   attention. **The AI never releases anything.**
4. `/api/ceo/contract/decision` (CEO-gated) is the only path that sets
   `sent_to_gp`. No route reaches the doctor without it.
5. Doctor can request a change → `changes_requested` → CEO triages via
   `/api/ceo/contract/change-decision`: either release to the practice
   (`practice_review`, consent token) or decline (contract stands, straight back
   to the doctor, no practice round-trip).

Doctor-facing CTAs (owner call 2026-07-28): change released → **"View position"**
(deliberately not an accept CTA — terms are in flux); change declined →
**"Accept position"**; contract released → **"Accept position"**.

## 4. Behaviour changes that reversed earlier deliberate decisions

Both were considered choices with comments explaining them. They were overridden
on 2026-07-28. **Do not "restore" them without asking.**

- **Turn-down now automated.** Previously a practice turning a candidate down
  left `status`/`ats_stage` untouched and sent the doctor *nothing* — the team
  followed up personally ("kinder, avoids a robotic rejection landing
  unannounced"). Now it closes the application, emails the doctor ("gone with
  another candidate"), and hides that practice from their careers page.
  ⚠️ **RSOs should know the doctor may now hear before they do.**
- **Practice hidden after a turn-down.** Keyed on `practice_id` where present —
  so a corporate group's *whole estate* hides together, which is intended (the
  group said no). Falls back to `practice_name`. Applied inside
  `_applyGpRoleVisibilityGate` BEFORE the DPA blur, so a hidden role cannot
  reappear as a redacted stub. **Fails OPEN** on lookup error — a blank careers
  page is a worse failure than briefly showing a practice that passed.

## 5. Data gotchas (verified against production, not assumed)

- `career_roles.title` is **not** reliably a job title. Across all 64 live rows:
  40 have the *clinic name* in `title` with the corporation in `practice_name`
  (every ForHealth/Spectrum row); 13 are `role || clinic`; 5 are `clinic || role`;
  5 are a bare role. The `||` separator appears in **both orders** — position
  cannot decide which half is which. `atsJobDisplayNames` (server) /
  `mbPracticeDisplay` (client) decide by *which half reads as a job title*.
  **Keep those two in sync.**
- Corporate groups share **one** `practice_id` and one `practices` row named for
  the corporation. There are no per-clinic practice records — the clinic name
  exists only in `career_roles.title`.
- Fixing code does **not** fix existing rows. After the status change, one row
  (Khaleed's, created 2026-07-26) still carried `status:'applied'` and was
  patched by hand. If you change how rows are written, **check what is already
  in the table** — filter used:
  `status=eq.applied&ats_stage=eq.shortlisted&match_outcome=is.null&origin=eq.ai_matched`.

## 6. Environment gotchas

- **No Node on PATH.** Download a temp one:
  `curl -sL https://nodejs.org/dist/v20.19.0/node-v20.19.0-darwin-arm64.tar.gz`
  into `$CLAUDE_JOB_DIR/tmp`, then symlink the main checkout's `node_modules`
  into the worktree. CI uses Node 20.19 + `NODE_OPTIONS=--experimental-require-module`.
  **Run `npm test` — it has caught real bugs a manual read missed.**
- `gh` was installed at `~/.local/bin/gh` (2.96.0) but is **not authenticated**.
  `gh auth login` as `Gplinkrecruitment` would let sessions open PRs.
- The local checkout lags `origin/main` by hundreds of commits. Always branch
  from a **fresh** `origin/main`; `main` moves several times an hour.

## 7. Verifying a deploy — do not skip this

Push to `main` auto-deploys to production in ~45–60s. To confirm a change is
actually live (**a successful push is not proof**):

```bash
curl -s https://app.mygplink.com.au/api/health   # → {"commit":"<sha>","branch":"main",...}
git rev-parse origin/main                        # same value = deployed
```

`/api/health` reporting the commit was added on 2026-07-27 precisely because a
fix was twice reported "live" when it had reached nobody.

⚠️ **Cache busters.** `js/*.js` is requested with `?v=YYYYMMDD[letter]`. Shipping
a change to such a file **without bumping the token in the referencing HTML ships
nothing** — browsers keep serving the cached URL. Two tests pin the
`ceo-ats-matching.js` token (`matching-board-ui`, `ai-matching-pipeline`); update
both. Pages themselves are `must-revalidate`, so HTML changes need no bump.

## 8. Open / not done

> **Corrected 2026-07-28 (second session), against the code and production.**
> Item 1 previously read "phone and in-person interviews stall silently … the
> biggest remaining hole". **That was wrong when it was written.** The
> time-based fallback had already shipped on 2026-07-22 in `ba9dae0`
> ("interview_completed status + time-based completion when Zoom is absent"),
> six days earlier. What follows is what is actually still open.

1. **Non-Zoom interviews are covered — but only ~90 min later, and only for
   7 days.** `/api/cron/detect-no-shows` (every 10 min) has a zoomless branch
   (`hasZoomMeetingId === false`): once the scheduled end time plus 15 min has
   passed it flips the call to `completed` and fires the *same*
   `sendPostInterviewDecisionEmail` as the Zoom webhook. So a phone/in-person
   interview booked in the app **does** reach the practice. Two real edges remain:
   - The cron only selects `scheduled_at > now − 7 days`. A booked interview not
     resolved inside that window (cron outage, a row that sat past it) **drops
     out permanently** — nothing ever completes it.
   - It counts as `presumedComplete`, not `attended`: with no Zoom attendance
     record we are *assuming* the interview happened. A silent no-show gets the
     practice a decision email anyway.
2. **`career_interviews` is a second, orphaned interview store.** The scheduling
   route that writes it (`format` = `video`/`phone`/`in_person`, sets
   `gp_applications.status = 'interview_scheduled'`) is **never swept by any
   cron** — nothing there can ever reach `interview_completed`. It is harmless
   today only because the table is **empty in production** (verified
   2026-07-28); the live flow uses `scheduled_calls` with
   `meeting_kind='interview'`. ⚠️ **Do not revive that route without wiring
   completion**, or you reintroduce exactly the stall item 1 warned about.
3. **`applied_at` is stamped at shortlist time**, before the doctor applies.
   Harmless today (the accept path overwrites it) but wrong if a screen ever
   reads it without checking status.
4. **Auto-chase hangs off `interview_completed`**, which *both* the Zoom webhook
   and the zoomless cron branch stamp — so it is not Zoom-only. Cadence: day 3,
   day 5, owner escalation day 7, weekends skipped for practice-facing sends
   (`/api/cron/practice-decision-reminders`, Pass B).

**Scale check (production, 2026-07-28).** Worth knowing before ranking any of
this as urgent: `gp_applications` holds **6 rows total** — 1 `shortlisted` (the
AI-matched one from 2026-07-26), 1 `interview`, 2 hired/secured, 1 withdrawn,
1 closed. **No row has ever reached `interview_completed`**, and the only two
`meeting_kind='interview'` calls are one `invited` and one `cancelled`. The
post-interview path has not yet run end-to-end on a real doctor, so none of the
above has harmed anyone — but it also means **none of it is proven in the wild.**

## 9. Where things live

| What | Where |
|---|---|
| Matching board UI | `js/ceo-ats-matching.js` (`mbPracticeDisplay`) |
| Clinic-vs-corporation naming (server) | `server.js` → `atsJobDisplayNames` |
| Doctor-facing status derivation | `server.js` → `buildInternalCareerStatusPresentation` |
| Careers cards + routing | `pages/career.html` |
| Practice/role page, accept & decline | `pages/job.html` |
| Application tracker (bounces pending matches) | `pages/application-detail.html` |
| Shortlist insert | `server.js`, `/api/ats/matching/shortlist` |
| Accept | `acceptShortlistedMatchRow` |
| Practice turn-down | `/api/practice/application/decision` |
| Practice hiding | `_rolesHiddenByPracticeTurnDown` |
| Auto-chase | `/api/cron/practice-decision-reminders` |
| Interview completion (Zoom) | `handleZoomMeetingEnded` (`meeting.ended`) |
| Interview completion (no Zoom) | `/api/cron/detect-no-shows`, `hasZoomMeetingId` branch |
| Post-interview decision email | `sendPostInterviewDecisionEmail` (idempotent, write-then-send) |
| Orphaned second interview store | `career_interviews` — empty in prod, no cron sweeps it |
