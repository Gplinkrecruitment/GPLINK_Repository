# Australian GP build: independent final review

An agent with a fresh context reviewed the branch at `b22e69eb` against
`origin/main` (`2f085f90`): 228 commits, 975 files. It reviewed and reported;
it fixed nothing. "Verified" means it reproduced the point on the running app
(local stack, fake identities). "Code read" means it was traced in code and
not run. Its working notes, screenshots and the 68 captured messages are on
this machine at `~/.claude/jobs/3f9de761/tmp/final-review/` (not in the repo).

## Round 1 verdict (23 Nov 2026)

**Ready for the owner to test on the local test stack; not ready to be
switched on for real doctors.** One blocker and nine required defects.

What it confirmed:

- Tests: 11,465 passed, 3 skipped, 1 failed (the cron-health test, which fails
  identically on a clean `main`). 121 inline scripts and 73 script files parse.
  The server starts cleanly.
- Doctor journey at phone width, as a new Australian VR GP, completed end to
  end (site, booking form, sign-up, onboarding, careers, apply, interview,
  offer, signing, pre-start, provider number, commencement to week 12): no
  banned word on any doctor screen; every email in that journey clean; no
  horizontal overflow. Not seen: the Calendly booking step (blocked on
  purpose) and anything AI-written.
- Staff side on screen: create candidate, verify Ahpra, set pathway, submit,
  every pre-start task, confirm commencement ($18,000 part-time, 84-day
  guarantee, check-ins at weeks 1, 4, 8, 12). Lists, case profile, task queue,
  documents, metrics and digest show the Australian doctor correctly.
- Practice side: introduction email, decision page, interview times, offer
  upload, placement confirmation, with no overseas wording. The five-step
  intake was not completed (address look-up is blocked locally).
- Automations: 27 jobs at day 0 and the lifecycle jobs at days 8, 29, 57, 71,
  85 and 95 (dates backdated on fake rows): no overseas task or message
  reached the Australian doctor; every lifecycle reminder fired. Hazel, with
  her dialler on and an Australian number set, rang nobody.
- Regression: it ran `main`'s own server against the same local database.
  Switch off: 24 API answers and every public site page identical to `main`;
  twelve UK-doctor screens identical; a new UK sign-up's welcome email
  byte-identical. Not compared: a full overseas journey through placement.
- Safety: nothing left the machine; `origin/main` unchanged; every migration
  statement additive; an unconfirmed-19AB doctor saw only the DPA role.
- Coverage: 124 of 134 findings done and wired in; three partial (ADM-21,
  APP-19, DAT-11); N01 to N22 each have a builder, trigger, once-only guard
  and test; all cited commits exist.

## Fix bundle FR-1 (23 November 2026)

Branch `worktree-agent-a9dcff150ee9bf2f4`. It handled B-01, R-01 to R-09, S-02,
S-03, S-04, S-05, S-11 and M-06; the Status column below says which commit and
what was done. Two migrations were added (applied to the local test database
only): `20261123110000_au_gp_fr1_server_owned_columns_guard.sql` and
`20261123120000_au_gp_fr1_doctor_details_cascade.sql`. B-01 and R-08 are only
fully closed on a database where those migrations have been applied.

## Defects, round 1

| # | Severity | What it means | Where / how to reproduce | Correct behaviour | Status |
| --- | --- | --- | --- | --- | --- |
| B-01 | blocker | A doctor can make themselves a "staff-confirmed" Australian VR GP: a held segment B or C doctor lifts their own hold and staff see "Confirmed by staff". Verified. | The pathway and confirmation columns are on `user_profiles`, and production lets a signed-in user update their own row there (policy `profiles_update_own`). Sign in as a held doctor, take a token from the sign-in service with the public key, `PATCH /rest/v1/user_profiles` setting `candidate_pathway: 'au_vr'` and `pathway_confirmed_at`: 200. `gp_credentials` refused the same token (403), so non-DPA roles stayed closed. | Only the server can write these columns | fixed in `683a35b9`: database guard (triggers on `user_profiles` and `user_state`; migration `20261123110000_au_gp_fr1_server_owned_columns_guard.sql`). Needs the migration applied to take effect |
| R-01 | required | An Australian GP can receive the overseas welcome email ("now let's map your move… AHPRA, AMC & visa"). Verified. | Sign up from `/australian-gps` without the booking form, verify the email, do not answer the first onboarding question for an hour; the hourly backstop (`server.js`, the held-welcome release) ignores the sign-up record, which already says the visitor came as Australian. Code read: the same doctor is enrolled in the overseas onboarding reminders ("Don't lose momentum on your move to Australia") | An Australian sign-up gets the Australian or a neutral welcome, never the overseas one | fixed in `b31217cf`: Australian evidence recorded at sign-up decides the welcome and keeps overseas reminders away |
| R-02 | required | A held doctor can re-answer onboarding and become segment A. Verified. Code read: an already-onboarded overseas doctor can post the same request and move onto the Australian pathway | A self-declared registrar re-posts `/api/onboarding/complete` with specialist and FRACGP answers: reply `au_vr`, `launched: true`; roles appear. `completeAuOnboarding` protects only a staff-set pathway | A later self-answer never loosens the pathway; it goes to staff review | fixed in `2f1b717a`: a repeat completion never loosens the pathway; different answers go to segment review |
| R-03 | required | A doctor's own typed provider number closes the staff task and is later stated as recorded; after the case was complete it could be overwritten. Verified | `/pages/pbs`: type a made-up number | The doctor's entry is unverified until staff confirm, and never overwrites a staff-recorded number | fixed in `6f66e3e9`: a doctor-typed number is held for staff confirmation and never overwrites a staff-recorded one |
| R-04 | required | A doctor can edit staff-verified registration facts and the verified stamp stays; the practice introduction then states the edited fellowship as confirmed. Verified (edit) / code read (intro) | `POST /api/account/au-details` | Lock these fields once verified, or clear the stamp and re-open the check | fixed in `2f1b717a`: verified facts are locked for the doctor; an edit becomes a change request on the re-opened Ahpra check |
| R-05 | required | The staff Ahpra check can confirm a VR GP against what staff saw: "Save as verified" does not require the registration type or the specialist-register answer; the derivation ignores the specialist flag, supervision level and expiry, and accepts a past expiry | The Ahpra check card; `derivePathwayFromRegisterCheck` in `lib/candidate-pathway.js` | A missing or contradicting specialist answer, any supervision, or an expired registration must not produce a confirmed `au_vr` | fixed in `2f1b717a`: `au_vr` needs specialist-GP yes, no supervision, an unexpired registration; "verified" requires every answer |
| R-06 | required | WhatsApp is not held back the way the documents say: nine templates are approved by default; two lead templates would reach segment B and C leads with fixed wording that promises matching and open roles; `scheduled-jobs.md` and `whatsapp-live-templates.md` say these are skipped. Code read | `lib/au-whatsapp-templates.js` | The two lead templates off for B and C; documents corrected | fixed in `aabc7aa8`: the two role-promising lead templates go to segment A leads only; documents corrected |
| R-07 | required | A practice name containing HTML is sent live in doctor emails. Code read | `lib/au-placement-messages.js` (N11, N15 to N20) | Escape names in these builders | fixed in `8cb511c5`: one shared helper (`lib/au-safe-text.js`) in every Australian builder |
| R-08 | required | Referee details and provider numbers survive account deletion. Code read | `au_gp_doctor_details` has no link to the user row and nothing deletes from it | Deleted with the account | fixed in `ba27019c`: cascading foreign key (migration `20261123120000_au_gp_fr1_doctor_details_cascade.sql`) and deletion in every account-delete path |
| R-09 | required | A doctor who has resigned keeps getting check-ins: a last working day in the future is refused, so the "How is it going?" and thank-you emails continue. Code read | `lib/au-commencement.js` | Staff can record notice given, which pauses them | fixed in `73f987cf`: "Notice given" pauses check-ins and becomes the exit on the last working day |
| S-01 | should | With the switch on, the welcome email is delayed for every new sign-up (released by the hourly job); three ways it can be lost silently (code read) | Held welcome (WP-17) | Owner decision 76; make it loss-proof | partly fixed in FR-7: two of the three ways are closed (a hold that cannot be written sends the neutral welcome at once; a release claim that cannot be written keeps the hold). The third (the email service itself failing) is the same on `main`. The delay itself is owner decision 76 |
| S-02 | should | The Australian welcome arrives in the wrong order: "finish your profile" after "Your profile is complete" and "Your Ahpra registration is confirmed". Verified | N04 fires at email verification | Not sent once the profile is complete | fixed in `b31217cf`: N04 is not sent once the profile is complete or N08 / N06 have gone |
| S-03 | should | The start date accepts nonsense (before the notice date) and both sides are emailed "confirmed" at once; once the task closes no screen offers a change. Verified | Start-date form | Validate; allow a correction on screen | fixed in `73f987cf`: validated before anything is sent; "Correct start date" on the pre-start card |
| S-04 | should | Consultants can read the fee: `GET /api/admin/au/commencement` as a consultant returns the fee amount and invoice fields. Verified | That route | CEO only, as elsewhere | fixed in `73f987cf`: view and action results redacted for anyone but the CEO. Still open: the CEO invoice / credit task wording (amount, percentage) is readable by an RSO through the general admin task routes |
| S-05 | should | A failed database read lifts the hold: an unreadable pathway is treated as an ordinary overseas doctor. Code read | `lib/role-eligibility.js` around line 209 | Unreadable means restricted (fail closed) | fixed in `bc71735a`: unreadable means nothing can be applied for on that request |
| S-06 | should | Turning the switch off is not a clean rollback for a placed Australian doctor (they see the overseas app). Verified | By design; OWNER-ACTIONS 89 | Documented | accepted |
| S-07 | should | An unverified, self-declared VR doctor can apply to a DPA role straight away (non-DPA stays hidden). Verified | Careers before the staff check | Owner decision | open (owner) |
| S-08 | should | Small switch-off differences from `main`: `/api/public/features` exists; an extra read for finished cases; Hazel refuses Australian leads whatever the switch says; onboarding waits on a new request before painting | Various | Documented exceptions; check the onboarding wait | left, documented (CONVENTIONS section 2). The onboarding wait is one small request, capped at 4 seconds |
| S-09 | should | The migrations hard-code the allowed stage and task-type lists copied on 20 Nov | `…wp03_stages.sql`, `…wp06_task_types.sql` | Re-read the live constraints immediately before applying | to do at apply time |
| S-10 | should | On a slow connection the Australian landing page falls back to the overseas form after 2.5 s and onboarding after 4 s; the word filter deletes whole sentences containing a banned word | `js/` loaders | The Australian page never falls back to the overseas form | partly fixed in FR-7: a visitor from an Australian page is never handed the other form on a slow or failed answer (it retries, then says so); onboarding waits 20 seconds, not 4, on a device already known to be Australian. The word filter cutting whole sentences is by design and left |
| S-11 | should | "Request item" reports success when nothing was sent. Code read | `server.js` (pre-start request route) | Truthful result | fixed in `73f987cf`: success only when the email or bell went; otherwise it says what was skipped |
| S-12 | should | A placed Australian doctor who deletes their account is purged after 90 days with no CEO task (DAT-24). Code read | Account purge | Owner decision 16 | open (owner) |
| S-13 | should | Ownership gaps: a self-signed-up doctor has no placing consultant until submitted; Australian tasks have no assignee; the pre-start "RSO" is the admin pool. Verified | Staff side | Owner decisions 25 and 44 | open (owner) |
| S-14 | should | The case closes itself at week 12 with the invoice unsent (it stays in the CEO's "Needs you"). Verified | Lifecycle job | Owner decision | open (owner) |
| S-15 | should | Money can slip through the match-reason filter when written without a symbol; a held placement can be released twice; a failed ledger write loses the week 4/8/12 messages; practice emails cite "clause 7" even when the agreement on file is unknown. Code read | Various | Fix each | the double release is fixed in FR-7 (S7-03). The other three parts: open |
| M-01 | minor | Home page tab title still says "for Overseas Doctors"; `/start` shows overseas copy under the new first question | Site | Neutral with the switch on | open |
| M-02 | minor | "Offer and contract: Not ready yet" shows after the contract is signed, on both sides | Pre-start "We prepare" | Shows signed | open |
| M-03 | minor | The pre-start page lists documents twice; five "Document Verified" emails in one minute | Pre-start page; document emails | Once; batched | open |
| M-04 | minor | Staff see "Preferred locations: Perth" when the doctor chose Perth and Regional WA | Drawer | Full list | open |
| M-05 | minor | The digest says "Invoices due: 1" beside "Nothing Australian is waiting on you" | Digest | Consistent | open |
| M-06 | minor | The restraint check completes with no outcome recorded | Task form | Outcome required | fixed in `4857f883`: the admin task route refuses to complete a restraint check with no outcome |
| M-07 | minor | Coverage rows and `ENVIRONMENT.md` stale in places | Docs | Updated | open |
| P-01 | already on `main` | The cron-health test fails on `main` too | `tests/server-observability.test.js` | — | not ours |
| P-02 | already on `main` | The same row rule behind B-01 lets a doctor edit other profile fields on `main` | Live database policy | Owner | not ours |

## Round 2 verdict (24 Nov 2026)

A second fresh agent reviewed `3226d824` (base `origin/main` `5df0803e`).
Evidence on this machine: `~/.claude/jobs/3f9de761/tmp/final-review-2/`.

**Ready for the owner to test on the local stack; not ready to be switched on
for real doctors. No blocker remains on a database with all 12 migrations
applied. Five required defects remain.**

Confirmed by running: tests 11,739 passed, 1 failed (cron-health, identical
files on `main`), 12 skipped (3 fixture writers; 9 that exercise the real
database trigger and foreign key and run only with the local stack up: with it
up, all passed). Switch off against `main` run side by side: every public site
page identical; all 29 UK-doctor API answers identical; 12 UK screens
identical text; a new UK sign-up's three emails identical. Differences with
the switch off: `/api/public/features` exists, `/js/site-au-lead.js` is
served, four new page routes redirect instead of 404, and the HTML source of
sign-in, onboarding, practice-decision, the service worker and the app shell
carries additions that are gated in script. A fresh Australian journey from
site to week 12: 56 doctor screens, 8 practice screens and 44 messages, no
banned word, no commercial figure to a doctor. Segments B and C stayed held on
every route tried. Nothing left the machine; `origin/main` contains none of
this work; all twelve migrations additive.

Round-1 items: B-01 fixed where the guard migration is applied (no protection
otherwise); R-03, R-04, R-05, R-08, S-02, S-05, S-11 fixed; R-06 code fixed,
documents partly; R-01, R-02, R-07, R-09, S-03, S-04 partly fixed.

| # | Severity | What it means | Where / how to reproduce | Correct behaviour | Status |
| --- | --- | --- | --- | --- | --- |
| R2-01 | required | An Australian GP can still be sent the overseas welcome and, at about 58 hours, "Finish setting up" plus the overseas-only WhatsApp `gp_link_onboarding_step_start`. Ran | Press "Apply now" on a public job and create an account, or answer "Yes" on `/start` and use the page's "Create free account" link without sending the form; verify; do not answer the first onboarding question. Read: "Continue with Google" from the Australian page records no Australian marker | A sign-up nothing is known about gets a neutral welcome and neutral reminders, or these routes carry the marker; an overseas-only WhatsApp never goes to an account not known to be overseas | fixed in FR-2 (neutral welcome and reminder; positive overseas evidence; /start and Google carry the marker; the job page stays unmarked and is covered by the neutral wording) |
| R2-02 | required | A held doctor's later answers can still end in a staff-confirmed VR GP. Ran | (a) Onboard as "temporary resident, 19AB applies" (held, B); re-post `/api/onboarding/complete` with "citizen, 19AB no": the pathway is kept but the stored answers are overwritten; staff then save an ordinary verified Ahpra check (right to work is optional there) and the result is `au_vr`, confirmed, with nothing warning the person verifying. (b) An onboarded overseas doctor sets their own `onboarding_completed_at` to null through the database API, then posts Australian onboarding: self-declared `au_vr` | A repeat completion does not overwrite earlier restrictive answers; the check refuses to derive segment A while a segment review is open; "already onboarded" does not rest on a doctor-writable column | fixed in FR-2 |
| R2-03 | required | A plain tick undoes "Notice given", and it cannot be recorded again; a last working day of 2099 is accepted. Ran | `PUT /api/admin/task` with `{"status":"completed"}` on the notice task: the check-ins resume and no exit is recorded | The general task route refuses this task, as it does for start date and provider number; sensible date bounds | fixed in FR-2 |
| R2-04 | required | A practice or doctor name containing HTML still goes live in two doctor emails shared with overseas doctors ("a practice wants to meet you", "You have an offer to review"). Ran | `lib/practice-pipeline.js` around 821; `server.js` (offer-to-review email) | Escaped | fixed in FR-2 |
| R2-05 | required | A doctor who has started work and closes their account is purged after 90 days with no warning to anyone; the case with its invoice and check-in tasks is deleted and an active placement row is left behind. Ran | `userHasActivePlacement` looks for application status `hired`; in-app placements are `placement_secured` | A placed Australian doctor's deletion raises a CEO task and is not silently purged | fixed in FR-2 (Australian doctors; the overseas equivalent is reported to the owner, unchanged) |
| S2-01 | should | The database guard is the whole B-01 fix and covers only part of what the server trusts: still doctor-writable are `onboarding_completed_at`, `register_status`, `register_number`, `email`, `account_status`, `purge_after`, and the `user_state` keys `gp_au_signup_audience` and `gp_au_branch_started_at`; a doctor can insert their own `user_documents` row with `status: 'approved'` (ran: 201; whether it closes a pre-start task is unproven). The trigger discards silently | Database policies on existing tables (also on `main`) | Server-owned facts not writable by the doctor; documents approved only by staff | fixed in FR-2 for the parts assigned (document approval guard, two state keys, post-apply check) |
| S2-02 | should | An assigned RSO can read the fee and credit band through the general admin task and case routes (the invoice task's text). Ran | `/api/admin/tasks`, `/api/admin/case`, `/api/admin/ops/queue`, `/api/admin/ops/case` | CEO only | fixed in FR-2 |
| S2-03 | should | The doctor's home page says "Your notice. Your last working day at X is…" whenever staff record a notice, including practice-initiated reasons. Read | `js/au-prestart.js`, the notice view | Shown only when the doctor gave the notice; otherwise nothing | fixed in FR-2 |
| S2-04 | should | A verified doctor re-posting onboarding un-verifies their profile fields and withdraws the staff 19AB confirmation without telling staff. Ran | `completeAuOnboarding` | No silent change; staff told | fixed in FR-2 |
| S2-05 | should | A confirmed VR GP still rests on things staff never entered: no supervision field on the check form; fellowship and right to work optional. Ran | Ahpra check form | Required on the form | fixed in FR-2 |
| S2-06 | should | The WhatsApp documents still disagree with the code. Ran | `scheduled-jobs.md` row 9; `whatsapp-templates.md`; `whatsapp-live-templates.md` "Doctors" table | Documents match the code | fixed in FR-2 |
| S2-07 | should | The start date has no upper limit (2099 saved). Ran | Start-date form | Bounded | fixed in FR-2 |
| S2-08 | should | Switch-on changes that reach overseas users are not all listed in CONVENTIONS section 2 | Documentation | Complete list | fixed in FR-2 |
| S2-09 | should | A welcome skipped because a read failed is lost, not retried. Read | Held welcome | Retried | fixed in FR-2 |
| M2-01 to M2-07 | minor | An overseas doctor arriving via `/australian-gps` who answers "No" still gets the Australian welcome; an account that answered "Yes" but has not finished onboarding can open Careers and sees the overseas view; names with HTML come out mangled in safe emails; a restraint check can be cancelled with no outcome; a refused provider-number request still saved the "numbers you already hold" half; "cleared to start" says the credentialing pack "has gone to the practice" on a staff tick; walk-through annoyances (five "Document Verified" emails in 30 seconds; "Request item" emails the doctor for items already approved; every sign-in on an unverified account re-sends the verify email; "20 applied" on an empty database; an interview can be marked finished before it happens; the Careers stepper truncates at 390px; "Applications 0" after placement) | Various | — | M2-01, M2-04 and M2-06 fixed in FR-2; the others open |

## Round 3 verdict (24 Nov 2026)

A third fresh agent reviewed `073b3f4e` (base `origin/main` `5df0803e`, not
moved). Evidence on this machine: `~/.claude/jobs/3f9de761/tmp/final-review-3/`.

**Ready for the owner to test on the local stack; not ready to be switched on
for real doctors. No blocker. Two required defects remain, both introduced by
the round-2 fix for R2-01.**

Round-2 items: R2-01 fixed (introduced R3-01, R3-02); R2-02 fixed; R2-03
partly fixed (S3-01); R2-04 fixed for every email through the shared function
(side effect S3-06); R2-05 fixed (introduced S3-03). S2-03, S2-04, S2-05,
S2-07, M2-04 fixed; S2-01, S2-02, S2-06, S2-08, M2-06 partly; M2-01 not fixed
in a real browser.

Confirmed by running: tests 11,809 passed, 1 failed (cron-health, as `main`),
3 skipped. Switch off against `main`: every public page byte-identical, all 29
doctor API answers identical, 35 of 36 messages byte-identical on `main`,
switch off and switch on. One segment-A doctor from sign-up to "cleared to
start" at 390px, B and C held on every route; 109 screens and 33 messages, no
banned word, no fee figure. All thirteen `au_gp` migrations additive. Nothing
left the machine.

| # | Severity | What it means | Where / how to reproduce | Status |
| --- | --- | --- | --- | --- |
| R3-01 | required | Pressing "No" on the first question is never sent to the server in a form it reads. An overseas doctor who taps "No" and pauses for over an hour gets the neutral welcome and never today's "let's map your move" welcome; one who arrived from an Australian page still gets the Australian welcome and reminders. CONVENTIONS section 2 and owner action 136 say otherwise | `js/onboarding.js` `auAnswerNo` deletes `auBranch`; the server (`blobSaysNotAustralian`) looks for `auBranch === 'no'` | fixed in FR-3 |
| R3-02 | required | The neutral reminder ignores "Unsubscribe" and has no unsubscribe link; on the first daytime run after switch-on it would go to every parked, never-started account at once | The neutral branch in the onboarding reminder job runs before the `unsubscribed / stopped` check | fixed in FR-3 |
| S3-01 | should | A staff member can undo a notice (or fake a provider number or a 2099 start date) with a hand-made request: `PUT /api/admin/task` with `metadata_merge` | The merge is applied after the guard | fixed in FR-3 |
| S3-02 | should | The assigned RSO still receives fee and credit figures in data | `GET /api/admin/va/dashboard`, the reply to `PUT /api/admin/task`, `/api/admin/va/search` | fixed in FR-3 |
| S3-03 | should | A doctor who finished the guarantee period and closes their account is kept in full with no end until the CEO presses "Placement ended"; the CEO task still says "recoverable for 90 days" | From the R2-05 fix | fixed in FR-3 |
| S3-04 | should | After a completed purge the server's onboarding record (`runtime_kv` `au_onboarded:<id>`, new in this build) remains; also the email in `user_session_epoch` and uploaded files (likely the same on `main`) | Purge | fixed in FR-3 for the onboarding record (what main leaves is reported, unchanged) |
| S3-05 | should | The hourly reminder job now does 3 to 8 reads per never-started account every hour, bounded only by a 45-second budget with no cursor | Onboarding reminder job | fixed in FR-3 |
| S3-06 | should | A bare "<" in a doctor email now shows as "‹", with the switch off as well: an undeclared switch-off difference | From the R2-04 fix | fixed in FR-3 |
| S3-07 | should | A consultant can confirm a VR GP through "Set and confirm pathway" for a doctor whose first answers were restrictive, with no comparison shown; the open review auto-closes | `POST /api/admin/candidate/pathway` (deliberate, recorded by name) | fixed in FR-3 |
| S3-08 | should | A doctor can swap the stored file or extend the expiry on a staff-approved Australian document and it stays approved | Database API on own `user_documents` row | fixed in FR-3 (migration written, to be applied by the coordinator) |
| S3-09 | should | An RSO can tick or cancel the CEO's "Decide the guarantee credit" task with no decision, and cancel the invoice task with any reason | `PUT /api/admin/task` | fixed in FR-3 |
| S3-10 | should | Documents: section 2 misses S3-06, three failed-read changes and the R3-01 behaviour; `whatsapp-live-templates.md` had three unrelated columns overwritten; the migration's post-apply check would not notice the guard file re-run out of order | Documentation | fixed in FR-3 |
| M3-01 to M3-08 | minor | Pre-start page still says the pack "has gone to" the practice; a doctor re-doing onboarding sees "You're all set" with no "nothing was changed"; the Ahpra form's compare block shows raw field names and the resolve tick box when no review is open; home marks two steps "Current step" after cleared to start; Australian leads in B and C get the main welcome wording; a real read-then-write race when "Apply now" is clicked twice within a fraction of a second (WP-22); `<b>` in a name still renders bold in doctor emails; two "Notice given" tasks left open after the S3-01 bypass. Still open from before: double escaping in practice emails (M2-03), the Yes-but-unfinished account seeing the overseas Careers view, walk-through annoyances | Various | M3-01, M3-02, M3-03, M3-06, M3-07 and M3-08 fixed in FR-3; M3-04, M3-05 and the older items open. M3-04 fixed in FR-7 (one current step, server and browser). M3-05 fixed in FR-7 (segment B and C leads get the careful welcome). M2-03: not a defect (see FR-7) |

Live product findings (also on `main`, not defects of this build): the
"Welcome, set your password" and "AMC Complete" emails put names in as live
HTML; about eight other email call sites do not escape the doctor's first
name; RSO notes search is not limited to the RSO's own cases; sign-up strips
apostrophes from names; the offer email always says "competitive role with
strong interest".

## Round 4 verdict (24 Nov 2026)

A fourth fresh agent reviewed `f9f40b0b` (base `origin/main` `5df0803e`, not
moved). Evidence on this machine: `~/.claude/jobs/3f9de761/tmp/final-review-4/`.

**Ready for the owner to test on the local stack; not ready to be switched on
for real doctors. No blocker. One required defect remains (R4-01).**

R3-01 fixed with one gap (S4-03); R3-02 fixed, introduced S4-01 and S4-02;
S3-03, S3-04, S3-05, S3-06 fixed; S3-01, S3-02, S3-07, S3-08, S3-09, S3-10
partly. Confirmed by running: tests 11,838 passed, 1 failed (cron-health, as
`main`), 3 skipped; 25 browser sign-ups at 390px: every "No" reaches the
server, every "No" doctor got today's welcome exactly once, nobody got two
welcomes of one kind; an overseas doctor's welcome and first two reminders
byte-identical to `main`; public pages byte-identical with the switch off; on
`main`'s code a doctor who answered "No" while the switch was on behaves
normally; fourteen migrations additive; nothing left the machine.

| # | Severity | What it means | Where / how to reproduce | Status |
| --- | --- | --- | --- | --- |
| R4-01 | required | A doctor who presses "Download my data" sees the titles of staff tasks on their case: the CEO's invoice and credit tasks and a notice nobody has told them about (no dollar figure or percentage) | `GET /api/account/export` lists every staff task title | fixed in FR-4 |
| S4-01 | should | An Australian GP who waits a day, then answers "Yes" and stops part-way, never gets the "finish your profile" reminders | The reminder row is parked as stopped and never un-parked for these doctors | fixed in FR-4 |
| S4-02 | should | Turning the switch off does not bring reminders back for accounts parked while it was on, including overseas doctors mid-series | `stopped_reason = au_audience_unknown` stays on `main`'s code | fixed in FR-4 (clean-up statement for rows already parked is in the FR-4 report) |
| S4-03 | should | A doctor who taps "Yes" by mistake, then "Change my answer" then "No", never gets today's welcome | `/api/onboarding/save` only releases a welcome on the first answer | fixed in FR-4 |
| S4-04 | should | A held segment-B doctor can still be released as a VR GP with no comparison: by a hand-made request with `confirmed:false`, or by the CEO ticking the "Decide the segment" task and then saving the pathway | `POST /api/admin/candidate/pathway` | fixed in FR-4 (including the no-pathway case) |
| S4-05 | should | An RSO can close any guarded task through another route, and the doctor is emailed "Document Verified" | `POST /api/admin/va/task/review-flagged-doc` has no task-type, guard or assignment check (route exists on `main`) | fixed in FR-4 (guard at the one common writer) |
| S4-06 | should | The CEO can no longer finish the "Replacement or credit" task | `lib/au-task-guard.js` refuses "completed" for that kind always | fixed in FR-4 |
| S4-07 | should | An assigned RSO can still read the fee: a timeline line holding the whole task metadata is written on a metadata merge or when the CEO cancels a commercial task, and RSO search returns it | `PUT /api/admin/task`; `/api/admin/va/search` | fixed in FR-4 |
| S4-08 | should | Swapping the file behind an approved indemnity certificate drops it to "uploaded" but the pre-start step stays closed and no task opens | `lib/au-prestart.js` leaves indemnity out of the document check | fixed in FR-4 |
| S4-09 | should | The AI case summary is given every task title and the last 20 timeline titles whatever the viewer's role, including "Guarantee credit decided: 65%"; the cached summary is shown to RSOs (read only; AI is off locally) | Case summary prompt input | fixed in FR-4 |
| M4-01 to M4-06 | minor | A real race when "Apply now" is pressed on two roles within milliseconds; an RSO can reopen a withdrawn notice task that then cannot be closed; a doctor re-doing onboarding and changing only preferences sees "You're all set" but nothing is saved; documents (what an unanswered sign-up from an Australian page receives; no rollback note; post-apply checks); `<b>` in a last name or practice name still renders bold in doctor emails; a "No" saved within milliseconds of verification gets its welcome within the hour instead of at once. Also seen: a consultant sending `{pathway:null}` clears a held doctor's pathway | Various | M4-01 to M4-04 fixed in FR-4; M4-05 fixed for the doctor's own names (a practice name in an overseas builder: open); M4-06 open. M4-06 fixed in FR-7 (one small read after the hold is written releases the welcome at once) |

## Round 5 verdict (24 Nov 2026)

A fifth fresh agent reviewed `1040e58b` (base `origin/main` `5df0803e`, not
moved). Evidence on this machine: `~/.claude/jobs/3f9de761/tmp/final-review-5/`.

**Ready for the owner to test on the local stack. No blocker. One required
defect remains (R5-01), and it is small.**

R4-01 fixed for tasks (R5-01 and S5-01 are adjacent gaps); S4-01, S4-02,
S4-03, S4-04, S4-06, S4-07, S4-08, M4-01, M4-03, M4-04, M4-05 fixed; S4-05 and
M4-02 fixed on the general routes (S5-02 remains); S4-09 fixed on the summary
route. Confirmed by running: tests 11,864 passed, 1 failed (cron-health, as
`main`), 3 skipped. The task guard in the database transport: with the switch
off, 910 staff task actions on an overseas case matched `main` request for
request (no extra read); with the switch on, no overseas write refused or
altered, at a cost of one to two extra reads on the task routes that complete,
cancel or merge metadata. Every Australian own action worked on the real
server. A whole overseas reminder series (welcome, 7 reminders, 1 WhatsApp)
is byte-identical to `main`; `main`'s code over accounts parked by this build
carries on today's series. Held B, C and A-then-B doctors: every opening
change refused for CEO and consultant; an honest resolve works. 182 RSO and
128 consultant answers show no fee, percentage or clause text. Fourteen
migrations, none added this round; nothing left the machine.

Read only, not run: the guard's behaviour when its own lookup fails (the write
is refused, with the switch on only), the daily job's task writes, generated
AI summary output (AI is off locally). Not verified: segment-B own actions;
several overseas staff actions that could not be driven to a real write
locally (SPPA send, alternative supervisor CV, document approve/crop): they
returned the same refusals on `main`, switch off and switch on.

| # | Severity | What it means | Where / how to reproduce | Status |
| --- | --- | --- | --- | --- |
| R5-01 | required | An Australian doctor who presses "Download my data" after being placed reads overseas wording ("before you relocate", "Relocation Explorer", "Relocation package", a field named `gmcNumber`). Nothing wrong shows on any screen | `GET /api/account/export` and `GET /api/state`: the server writes the overseas placement text into the doctor's saved state; the screens correct it in the browser, the download and raw state do not | fixed in FR-5 |
| S5-01 | should | Staff task titles can reach a doctor through `GET /api/gp/outstanding` when staff set a task to "waiting on GP" (the Australian home page does not draw that panel) | No Australian filter on that route | fixed in FR-5 |
| S5-02 | should | A withdrawn notice can come back as an open task nobody can close, and an RSO not on the case can change the CEO's tasks, through a hand-made request | `POST /api/admin/va/task/dismiss-attachment` sets any task to "waiting on practice" (route and its missing access check also on `main`) | fixed in FR-5 (the route's missing case-access check is on main too: reported, unchanged) |
| S5-03 | should | An RSO can reopen a completed invoice or credit task, set an in-between status and overwrite its description, priority, due date and assignee (recoverable through the CEO's own button) | `PUT /api/admin/task` | fixed in FR-5 |
| M5-01 to M5-06 | minor | No → Yes → No by hand-made request gives today's welcome twice; a reminder row stopped by earlier fix bundles does not heal if the doctor has since answered Yes (test databases only); the reminder memo is read in one request of 20,000 rows but the data service returns at most 1,000; after two "Apply now" presses milliseconds apart the newest staff line sometimes names the older role (the stored intent is right); a case summary stored before the fix is returned raw inside three case routes (test databases only); two unused fields in the guard | Various | M5-01, M5-03, M5-04 and M5-06 fixed in FR-5; M5-02 and M5-05 are test-database rows (clean-up statements in the FR-5 report) |

Live product findings (also on `main`): `dismiss-attachment` has no
case-access check; `GET /api/admin/tasks?case_id=` ignores the case filter;
an offer-contract upload turned a cancelled contract task into a completed
one; a doctor's support-ticket post returned success but created no row for
one overseas test doctor (not checked on `main`).

## Round 6 verdict (24 Nov 2026)

A sixth fresh agent reviewed `df0a0bb4` (the small FR-5 bundle). `origin/main`
had moved to `689f6977` (three unrelated fixes). Evidence on this machine:
`~/.claude/jobs/3f9de761/tmp/final-review-6/`.

**No blocker. Two required defects, both introduced by the state-cleaning step
that fixed R5-01.** The task-guard fixes (S5-02, S5-03), S5-01 and M5-01 hold.

Confirmed by running: tests 11,873 passed, 1 failed (cron-health, as `main`),
3 skipped; genuine overseas doctors' stored state, `/api/state` and export
identical to `main` and to switch-off; 406 staff task actions on an overseas
case identical on `main` and switch-off; the assigned RSO's ordinary pre-start
work still possible; an Australian doctor walked from onboarding to notice
with no banned word in the stored row, `/api/state` or the export.

| # | Severity | What it means | Where / how to reproduce | Status |
| --- | --- | --- | --- | --- |
| R6-01 | required | An Australian doctor's support messages are cut before staff see them: any sentence containing an ordinary word such as "overseas", "visa" or "AMC" is removed from what is stored, from the staff ticket and from the doctor's own thread | The write hook in the database transport runs the cleaner over the whole saved state, which holds support drafts, cases and messages | fixed in FR-6 (the general cleaner is removed) |
| R6-02 | required | A doctor whom staff moved from Australian to overseas is still treated as Australian by the cleaner and silently loses saved registration progress, including their MyIntealth ID | `auStateIsAustralian` decides from state content, not the recorded pathway; the staff pathway change does not reset the markers | fixed in FR-6 |
| S6-01 | should | The cleaner damages values that are not prose: URLs cut at the dots, array entries lost, any key containing "myintealth" dropped, short tokens such as a stage value emptied | `sanitiseDoctorState` | fixed in FR-6 (the cleaner is removed) |
| S6-02 | should | Staff can re-stamp an already completed guarded task (including a commercial one) as completed by themselves, and cancel a completed provider-number, start-date or restraint task with no reason | Status equal to the current status is treated as "no change", then the route stamps bookkeeping | fixed in FR-6 |
| M6-01 to M6-05 | minor | The cleaner's fast path misses a word after a line break; a staff-created Australian doctor who never onboarded has the overseas placement text in `/api/state` (not on any screen); the careers page writes "Relocation handover" into saved state on every visit; three failed-read fallbacks (a failed ledger insert loses an overseas doctor's welcome with no retry; `/api/gp/outstanding` shows an overseas doctor nothing if the pathway read fails; any staff task edit returns 503 if the guard's read fails); staff screens should not offer statuses the guard refuses | Various | M6-01 to M6-04 fixed in FR-6 (M6-02: one known limit, in CONVENTIONS); M6-05 (staff screens offering refused statuses) open. M6-05 fixed in FR-7 (item 147: the two staff menus leave out what the server refuses, with the reason) |

## Round 7 verdict (24 Nov 2026): the review loop is closed

A seventh fresh agent reviewed `efe22200` (the FR-6 bundle plus the merge of
`origin/main` at `689f6977`). Evidence on this machine:
`~/.claude/jobs/3f9de761/tmp/final-review-7/`.

**Ready for the owner to test on the local stack. No blocker and no required
defect remains.** Three "should" and five minor items, none of which changes
anything for a real overseas doctor in normal operation or shows a banned word
to an Australian doctor. They are NOT fixed; they are carried in HANDOVER.md.

R6-01 fixed (ran, 390px browser: draft, requests, follow-up and staff reply
with every banned word, URLs, line breaks, emoji and markup identical byte for
byte everywhere they are stored or shown). R6-02 fixed for the loss. R5-01
still fixed. S6-01, S6-02, M6-01, M6-02, M6-03 fixed. Confirmed by running:
tests 11,906 passed, 1 failed (cron-health, identical assertion on the new
`main`), 3 skipped; nothing rewrites stored state; a placed overseas doctor's
stored row, `/api/state` and export identical to a server running `main`;
database requests over a whole overseas journey equal on `main` and switch-off
(181 and 181); 410 staff task actions on an overseas case identical on `main`
and switch-off; every line `main` added is on the branch and its three new
test files pass; signed-out public pages byte-identical to `main`; a UK
journey's 18 screens and three emails identical between `main` and switch-off;
one segment-A doctor from on-screen sign-up to commencement with no banned
word; B and C held. Fourteen migrations, none added; nothing left the machine.

| # | Severity | What it means | Where / how to reproduce | Status |
| --- | --- | --- | --- | --- |
| S7-01 | should | A doctor staff have moved to "overseas" can carry on in the Australian sign-up wizard on the same phone, and finishing it puts them back as Australian (self-declared, unconfirmed, flagged for review), overwriting the staff member's choice | The doctor's device still holds the wizard and saves the Australian branch back | fixed in FR-7: the wizard follows the recorded pathway. An overseas pathway a person recorded is never replaced by the doctor's answers (the Australian save and finish are refused, 409); the page sets its Australian branch aside, keeping what was typed. Run on a real server and screen |
| S7-02 | should | A doctor moved to "overseas" after finishing the Australian sign-up is never asked today's sign-up questions (no country of training, no qualification documents) | Staff pathway change | fixed in FR-7 (the minimal safe form): the move raises one staff task "Still needs today's onboarding" and a timeline line, and `/pages/onboarding` opens today's wizard for that doctor. Nothing prompts the doctor by itself: a person asks them |
| S7-03 | should | If a doctor's pathway cannot be read at the moment staff record an overseas placement (switch on), the held placement is later released twice: duplicate "placement secured" emails and duplicate SPPA-00, Section G, Position Description and Supervisor CV tasks | `_auClearPlacementHold` returns true when the hold is already gone (round 1's S-15, now reproduced) | fixed in FR-7: the release is claimed once in the once-ever ledger, keyed on the hold. Run on a real server with three syncs at the same instant: released once, one of each task and email |
| M7-01 | minor | "View" on the Australian My Documents page silently saves a file called `document.pdf` instead of opening it | From adding `main`'s download helper to the Australian pages | fixed in FR-7: View is a button that opens the file in a new tab (the server now hands a PDF or picture over to be shown, `view=1`); Download saves it under its own file name. The other four Australian pages draw no such link |
| M7-02 | minor | A failed write on the first ledger entry still loses an overseas doctor's welcome email with no retry (switch on only) | Held welcome | fixed in FR-7: a claim that could not be written keeps the hold, so the next answer or the hourly job sends the welcome; nothing is sent twice |
| M7-03 | minor | An Australian doctor could be handed a staff task title by the raw list route if the pathway read fails while their only open task is a staff-made manual task set to "waiting on GP" (no screen draws it) | `/api/gp/outstanding` fallback | fixed in FR-7: on that fallback the doctor's case (its stage and mirrored pathway) is asked as well; an overseas doctor's list is unchanged |
| M7-04 | minor | The export makes one extra database read for every doctor with the switch on | `/api/account/export` | fixed in FR-7: the export takes the pathway from the profile row it already reads; an overseas doctor's export makes the same requests with the switch on as off |
| M7-05 | minor | A comment names a test file that does not exist; while the guard's own read is failing, a status change on an overseas task is refused with 503 (switch on only; retry works) | `lib/au-placement-wording.js`; task guard | comment fixed in FR-7. The 503 on an overseas task while the guard's own read is failing: left (switch on only; a retry works; unknown fails closed) |

## Fix bundle FR-7 (25 November 2026)

Closes the "should" and "minor" items left by round 7 and the rough edges
found while following the testing guide. Each fix has a test that fails on
the old code; the screens were followed in Chrome on a separate copy of the
app (port 3001, the local database, fake identities whose emails start
`fr7.`).

| Item | Result | What was run |
| --- | --- | --- |
| S7-01, S7-02 | fixed | Staff-created doctor, wizard on screen 2, moved to overseas by the CEO: the same phone then shows today's wizard, the typed answers are kept, a hand-made Australian save and finish both answer 409 |
| S7-03 | fixed | Placement recorded with the pathway unreadable; the doctor returns; three syncs at once: one release, one of each task, one of each email |
| Item 147 (M6-05) | fixed | Unit: the screen's rule agrees with the server's for every task kind, for the CEO and for others |
| M7-01 | fixed | View opens a new tab showing the file; Download saves it under its own name |
| M7-02, M4-06, S-01 (two of three) | fixed | Unit, with the ledger write made to fail |
| M7-03, M7-04, M7-05 | fixed | Unit; request counts compared with the switch off |
| M2-03 | not a defect | The round-2 doctor's name literally contained `&amp;`, so `&amp;amp;` was one correct escape. A doctor named "O'Brien & Co" at "Smith & Sons" was run through sign-up to placement: no doubled entity in 13 emails |
| M3-04, M3-05 | fixed | Unit (every stage and combination of facts; every lead segment) |
| Item 139 (Australian builders) | checked, nothing to fix | Every name in an Australian builder is cleaned and escaped once. The 27 older call sites are tabled in the FR-7 report: all but two are `main`'s code and are unchanged |
| RSO after placement | fixed | It was never round-robin: the case goes to the default RSO for new cases. The timeline now names the RSO, the placing consultant and the CEO are emailed once, and an RSO with no doctors is told why |
| Sydney-clock dates | fixed (the rule is unchanged) | A refused date says whose clock and the earliest date; the date boxes carry the same bounds |
| Messages held by quiet hours | fixed | Saving a start date at 9:28pm Sydney time: the screen says "Not sent yet ... It will be sent at about 11:00am on Thursday 26 November (Sydney time)". A held message goes on the next morning run, which is 8am in Perth and 10am or 11am in Sydney: the line says the real time |
| Sessions a week | fixed | A form in the page; empty and "20" refused with nothing sent; "8" sent |
| Invite link while another doctor is signed in | fixed for the Australian invite | The other doctor is signed out and "Create your password" is shown |
| Two email links | fixed / local | The Australian introduction has one button, "Review Dr …". The staff link was a local-stack setting |
| Practice card "Bunbury" | `main`'s, reported | A hand-typed address sends no coordinates; `Number(null)` is 0, so the server measures from 0,0 and the nearest city is Bunbury |
| Intake reopened part-way | fixed (switch on) | The DPA question's buttons come back |
| "20 applied", "Applications 0" | `main`'s, reported | Both are `main`'s deliberate rules, identical on `main` |

