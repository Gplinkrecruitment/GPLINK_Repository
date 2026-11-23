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
| S-01 | should | With the switch on, the welcome email is delayed for every new sign-up (released by the hourly job); three ways it can be lost silently (code read) | Held welcome (WP-17) | Owner decision 76; make it loss-proof | open |
| S-02 | should | The Australian welcome arrives in the wrong order: "finish your profile" after "Your profile is complete" and "Your Ahpra registration is confirmed". Verified | N04 fires at email verification | Not sent once the profile is complete | fixed in `b31217cf`: N04 is not sent once the profile is complete or N08 / N06 have gone |
| S-03 | should | The start date accepts nonsense (before the notice date) and both sides are emailed "confirmed" at once; once the task closes no screen offers a change. Verified | Start-date form | Validate; allow a correction on screen | fixed in `73f987cf`: validated before anything is sent; "Correct start date" on the pre-start card |
| S-04 | should | Consultants can read the fee: `GET /api/admin/au/commencement` as a consultant returns the fee amount and invoice fields. Verified | That route | CEO only, as elsewhere | fixed in `73f987cf`: view and action results redacted for anyone but the CEO. Still open: the CEO invoice / credit task wording (amount, percentage) is readable by an RSO through the general admin task routes |
| S-05 | should | A failed database read lifts the hold: an unreadable pathway is treated as an ordinary overseas doctor. Code read | `lib/role-eligibility.js` around line 209 | Unreadable means restricted (fail closed) | fixed in `bc71735a`: unreadable means nothing can be applied for on that request |
| S-06 | should | Turning the switch off is not a clean rollback for a placed Australian doctor (they see the overseas app). Verified | By design; OWNER-ACTIONS 89 | Documented | accepted |
| S-07 | should | An unverified, self-declared VR doctor can apply to a DPA role straight away (non-DPA stays hidden). Verified | Careers before the staff check | Owner decision | open (owner) |
| S-08 | should | Small switch-off differences from `main`: `/api/public/features` exists; an extra read for finished cases; Hazel refuses Australian leads whatever the switch says; onboarding waits on a new request before painting | Various | Documented exceptions; check the onboarding wait | open |
| S-09 | should | The migrations hard-code the allowed stage and task-type lists copied on 20 Nov | `…wp03_stages.sql`, `…wp06_task_types.sql` | Re-read the live constraints immediately before applying | to do at apply time |
| S-10 | should | On a slow connection the Australian landing page falls back to the overseas form after 2.5 s and onboarding after 4 s; the word filter deletes whole sentences containing a banned word | `js/` loaders | The Australian page never falls back to the overseas form | open |
| S-11 | should | "Request item" reports success when nothing was sent. Code read | `server.js` (pre-start request route) | Truthful result | fixed in `73f987cf`: success only when the email or bell went; otherwise it says what was skipped |
| S-12 | should | A placed Australian doctor who deletes their account is purged after 90 days with no CEO task (DAT-24). Code read | Account purge | Owner decision 16 | open (owner) |
| S-13 | should | Ownership gaps: a self-signed-up doctor has no placing consultant until submitted; Australian tasks have no assignee; the pre-start "RSO" is the admin pool. Verified | Staff side | Owner decisions 25 and 44 | open (owner) |
| S-14 | should | The case closes itself at week 12 with the invoice unsent (it stays in the CEO's "Needs you"). Verified | Lifecycle job | Owner decision | open (owner) |
| S-15 | should | Money can slip through the match-reason filter when written without a symbol; a held placement can be released twice; a failed ledger write loses the week 4/8/12 messages; practice emails cite "clause 7" even when the agreement on file is unknown. Code read | Various | Fix each | open |
| M-01 | minor | Home page tab title still says "for Overseas Doctors"; `/start` shows overseas copy under the new first question | Site | Neutral with the switch on | open |
| M-02 | minor | "Offer and contract: Not ready yet" shows after the contract is signed, on both sides | Pre-start "We prepare" | Shows signed | open |
| M-03 | minor | The pre-start page lists documents twice; five "Document Verified" emails in one minute | Pre-start page; document emails | Once; batched | open |
| M-04 | minor | Staff see "Preferred locations: Perth" when the doctor chose Perth and Regional WA | Drawer | Full list | open |
| M-05 | minor | The digest says "Invoices due: 1" beside "Nothing Australian is waiting on you" | Digest | Consistent | open |
| M-06 | minor | The restraint check completes with no outcome recorded | Task form | Outcome required | fixed in `4857f883`: the admin task route refuses to complete a restraint check with no outcome |
| M-07 | minor | Coverage rows and `ENVIRONMENT.md` stale in places | Docs | Updated | open |
| P-01 | already on `main` | The cron-health test fails on `main` too | `tests/server-observability.test.js` | — | not ours |
| P-02 | already on `main` | The same row rule behind B-01 lets a doctor edit other profile fields on `main` | Live database policy | Owner | not ours |
