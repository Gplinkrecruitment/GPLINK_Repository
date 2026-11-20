# Australian GP build: coverage

One row per finding ID in `review-report.md` and per new message (N01 to N22).
Status is `done`, `deferred` or `n/a`. Anything deferred says why. `open` means not yet built.

| ID | Severity | Work package(s) | Status | Commit | Notes / reason if deferred |
| --- | --- | --- | --- | --- | --- |
| ADM-01 | Blockers | WP-02, WP-03 | done | 9e050952, b84bec3a | Field part (WP-02): `user_profiles.candidate_pathway` (six values, NULL = overseas) mirrored on `registration_cases.pathway`, written only by `setCandidatePathway`, read by `resolveCandidatePathway`. Stages part (WP-03): the Australian ladder `placement, prestart, commenced, guarantee, complete` (`lib/journey-ladders.js`); an Australian doctor's case is created at `placement` with the pathway copied on, and a case that already existed is moved over once when the pathway is set. Both migrations are files only; not applied to any Supabase project (the lead asks the owner). Until the WP-03 migration is applied the live database rejects the four new stage values. Dashboards still draw the overseas rail for an Australian case (WP-26); no Australian funnel yet (WP-27). |
| ADM-02 | Blockers | WP-06 | open |  |  |
| ADM-03 | Blockers | WP-11 | open |  |  |
| ADM-04 | Blockers | WP-04 | open |  |  |
| ADM-05 | Blockers | WP-03, WP-26 | done (server); page controls deferred to WP-26 | b84bec3a | Server side done: for an Australian doctor the staff "verified stage" control accepts only Australian ladder stages, only forwards, moves the case with `advanceAuCaseStage` and writes nothing into the doctor's state (no EPIC / AMC / AHPRA flags). Reset GP and stage rollback answer 409 with a plain message and audit the refusal. Overseas doctors are unchanged. Deferred to WP-26: the pages still show the overseas stage dropdown, the Reset GP tool and the rollback picker for an Australian doctor (the server refuses them with a readable message). |
| ADM-06 | Blockers | WP-13 | open |  |  |
| ADM-07 | Blockers | WP-08 | open |  |  |
| ADM-08 | Required | WP-07, WP-26 | open |  |  |
| ADM-09 | Required | WP-06 | open |  |  |
| ADM-10 | Required | WP-11 | open |  |  |
| ADM-11 | Required | WP-11 | open |  |  |
| ADM-12 | Required | WP-06 | open |  |  |
| ADM-13 | Required | WP-07, WP-26 | open |  |  |
| ADM-14 | Required | WP-14 | open |  |  |
| ADM-15 | Required | WP-20 | open |  |  |
| ADM-16 | Required | WP-08 | open |  |  |
| ADM-17 | Required | WP-27 | open |  |  |
| ADM-18 | Required | WP-27 | open |  |  |
| ADM-19 | Required | WP-06 | open |  |  |
| ADM-20 | Should and nice-to-have | WP-26 | open |  |  |
| ADM-21 | Should and nice-to-have | WP-12 | open |  |  |
| ADM-22 | Should and nice-to-have | WP-14 | open |  |  |
| ADM-23 | Should and nice-to-have | WP-14 | open |  |  |
| ADM-24 | Should and nice-to-have | WP-27 | open |  |  |
| ADM-25 | Should and nice-to-have | WP-08 | open |  |  |
| ADM-26 | Should and nice-to-have | WP-26 | open |  |  |
| ADM-27 | Should and nice-to-have | WP-12 | open |  |  |
| ADM-28 | Should and nice-to-have | WP-26 | open |  |  |
| ADM-29 | Should and nice-to-have | WP-15 | open |  |  |
| ADM-30 | Should and nice-to-have | WP-13 | open |  |  |
| APP-01 | Blocker | WP-05 | open |  |  |
| APP-02 | Blocker | WP-05 | open |  |  |
| APP-03 | Blocker | WP-05 | open |  |  |
| APP-04 | Blocker | WP-05 | open |  |  |
| APP-05 | Required | WP-05 | open |  |  |
| APP-06 | Required | WP-06 | open |  |  |
| APP-07 | Should | WP-05 | open |  |  |
| APP-08 | Blocker | WP-03, WP-12 | done (WP-03 server part); client open (WP-12) | b84bec3a | Server part: `GET /api/auth/session` carries `auJourney` (stage, doctor-facing label, the five-rung ladder with done / current / upcoming) for a doctor on an Australian pathway, never `myintealth`; overseas responses have no such key. The MyIntealth, AMC, AHPRA and visa step pages are refused server-side for an Australian doctor. WP-12 still owes the client: `js/journey-stages.js`, the app shell and the home page still draw the overseas stage list. |
| APP-09 | Blocker | WP-12 | open |  |  |
| APP-10 | Blocker | WP-11 | open |  |  |
| APP-11 | Blocker | WP-12 | open |  |  |
| APP-12 | Required | WP-12 | open |  |  |
| APP-13 | Required | WP-12 | open |  |  |
| APP-14 | Required | WP-03, WP-04 | done (derivation + stage reminder); sweeps deferred to WP-04 | b84bec3a | An Australian doctor's case is no longer created at, or derived to, `myintealth`; the state sync stamps none of the overseas unlock keys for them; the stalled-doctor position is their Australian stage and the overseas stage-reminder email is skipped for it. Deferred to WP-04 (its scope): the sweeps that pick stalled cases are not pathway-filtered, so a chase task is still opened for an Australian case, and the overseas stage messages inside the state-sync automation are not gated. Exact list in `CONVENTIONS.md` section 12. |
| APP-15 | Required | WP-12 | open |  |  |
| APP-16 | Required | WP-12 | open |  |  |
| APP-17 | Blocker for B, C | WP-08 | open |  |  |
| APP-18 | Required | WP-02, WP-05 | done (helper in WP-02; call site in WP-05) | 9e050952 | Pathway and basis are now explicit columns with one writer (`setCandidatePathway`) and one reader (`resolveCandidatePathway`), so nothing new needs the three-field country fallback chain. WP-02 deliberately writes nothing for today's overseas onboarding (NULL stays NULL = overseas). WP-05 owes the call at Australian onboarding completion: `setCandidatePathway(userId, { pathway, setBy: 'self', confirmed: false })`. The existing fallback chain in `_resolveGpJobsProfile` is untouched; WP-08 replaces its use for the DPA gate. |
| APP-19 | Should | WP-08, WP-22 | open |  |  |
| APP-20 | Should | WP-12 | open |  |  |
| APP-21 | Should | WP-10 | open |  |  |
| APP-22 | Should | WP-08 | open |  |  |
| APP-23 | Blocker | WP-07 | open |  |  |
| APP-24 | Required | WP-07 | open |  |  |
| APP-25 | Should | WP-07 | open |  |  |
| APP-26 | Should | WP-12 | open |  |  |
| APP-27 | Nice | WP-12 | open |  |  |
| APP-29 | Should for B | WP-14 | open |  |  |
| WEB-01 | Blocker | WP-05 | open |  |  |
| WEB-02 | Blocker | WP-02, WP-15 | done (WP-02 profile side) | 9e050952 | Profile side: the doctor's record can now hold segment (pathway), location (`current_*` columns), Ahpra registration, VR status, 19AB status and visa status (`gp_credentials`). WP-15 still owes the lead side: `consult.segment` and carrying it to `scheduled_calls`, the Leads tab, the owner alert and CAPI. |
| WEB-03 | Blocker | WP-10 | open |  |  |
| WEB-04 | Blocker | WP-01, WP-19 | done | b42baca0; bc78f9f1 | Hazel never rings an Australian-segment lead on any call path (regular schedule, due call-backs, missed-consultation ring, owner "ring now", plus a last guard in `placeLeadCall`). Permanent per owner decision 7. WP-19: the Australian script exists as an inert draft file (`config/retell/hazel-prompt-au.md`); nothing reads it and nothing is published. Prompt-by-segment selection is deliberately NOT built (decision 7); the steps are in `docs/au-gp/hazel-au-script-notes.md` section 7. |
| WEB-05 | Required | WP-16 | open |  |  |
| WEB-06 | Required | WP-16 | open |  |  |
| WEB-07 | Required | WP-21 | open |  |  |
| WEB-08 | Required | WP-05, WP-15 | open |  |  |
| WEB-09 | Required | WP-22 | open |  |  |
| WEB-10 | Required | WP-08, WP-22 | open |  |  |
| WEB-11 | Required | WP-23 | open |  |  |
| WEB-12 | Required | WP-23 | open |  |  |
| WEB-13 | Required | WP-24 | open |  |  |
| WEB-14 | Required | WP-24 | open |  |  |
| WEB-15 | Required | WP-21 | open |  |  |
| WEB-16 | Should | WP-01 | done | see WP-01 commit | Stale "Australia is a final decline" comments corrected in `server.js` (`buildConsultLeadRow`, two places, and the `/api/public/consult-lead` handler) and `tests/lead-decline-requires-evidence.test.js`. Comment-only, no gate. |
| WEB-17 | Should | WP-15 | open |  |  |
| WEB-18 | Should | WP-17 | open |  |  |
| WEB-19 | Should | WP-25 | open |  |  |
| WEB-20 | Should | WP-21 | open |  |  |
| WEB-21 | Should | WP-21 | open |  |  |
| WEB-22 | Should | WP-21 | open |  |  |
| WEB-23 | Nice | WP-21 | open |  |  |
| WEB-24 | Nice | WP-21 | open |  |  |
| COM-01 | Blocker | WP-02, WP-03 | done | 9e050952, b84bec3a | Field part: pathway on the profile and mirrored on the case, plus the resolver every comms package will ask. No message or sweep reads it yet. WP-03 (b84bec3a): case creation and stage derivation are pathway-aware (an Australian doctor is created on, and stays on, the Australian ladder; overseas derivation unchanged). |
| COM-02 | Blocker | WP-04 | open |  |  |
| COM-03 | Blocker | WP-11 | open |  |  |
| COM-04 | Blocker | WP-09 | open |  |  |
| COM-05 | Blocker | WP-01, WP-16 | done (interim) | see WP-01 commit | Interim: with the switch on, an Australian-segment lead gets no chase email, no WhatsApp, no booking-link email and no no-show rescue message; the owner alerts still fire. The one-hour call reminder email (plain, join link) still goes. WP-16 completes this by replacing the hold (`auMessagesHeld` in `lib/au-lead.js`) with Australian copy. |
| COM-06 | Blocker | WP-01, WP-19 | done (script file); deferred (publishing) | b42baca0; bc78f9f1 | AU skipped at every call path (see WEB-04). AU prompt written as a draft file with a test for banned words, pay figures and inertness. Deferred by owner decision 7: second agent / prompt selection, the diff against the live Retell agent, and publishing. No Retell API call was made. |
| COM-07 | Blocker | WP-01, WP-05 | done (interim) | see WP-01 commit | Interim: with the switch on, eligibility-waitlisted users are left out of the onboarding nudge cron and the step follow-up (staff views still list them). WP-05 completes it with the AU wizard path, AU copy and step labels. `lib/dropoff-nudges.js` copy is untouched here. |
| COM-08 | Blocker | WP-17 | open |  |  |
| COM-09 | Required | WP-04 | open |  |  |
| COM-10 | Required | WP-14 | open |  |  |
| COM-11 | Required | WP-06 | open |  |  |
| COM-12 | Required | WP-11, WP-17 | open |  |  |
| COM-13 | Required | WP-08 | open |  |  |
| COM-14 | Required | WP-10 | open |  |  |
| COM-15 | Required | WP-15 | open |  |  |
| COM-16 | Required | WP-01 | done | see WP-01 commit | `applyPepWaitlistGate` refuses any country other than GB, IE and NZ (`isPepGatedCountry` in `lib/document-pipeline.js`), so both call sites are covered. Behind the switch as the lead directed; today's two callers only ever pass GB/IE/NZ, so it is a no-op for them in either state. |
| COM-17 | Required | WP-07 | open |  |  |
| COM-18 | Required | WP-17 | open |  |  |
| COM-19 | Required | WP-10 | open |  |  |
| COM-20 | Required | WP-17, WP-23 | open |  |  |
| COM-21 | Required | WP-27 | open |  |  |
| COM-22 | Should | WP-16 | open |  |  |
| COM-23 | Should | WP-17 | open |  |  |
| COM-25 | Should | WP-08 | open |  |  |
| COM-27 | Should | WP-10 | open |  |  |
| COM-28 | Should | WP-24 | open |  |  |
| COM-34 | Should | WP-19 | deferred (owner / legal) | bc78f9f1 | No legal position is asserted. `docs/au-gp/hazel-au-script-notes.md` section 4 lists 13 questions for a lawyer (Do Not Call Register Act and consent from an enquiry, AI/automated calls, calling-hours standard, Spam Act for follow-up messages, call recording by state, Privacy Act, AI disclosure). Section 5 proposes calling hours by state; not built. AU calls stay off until the owner has advice. |
| COM-40 | Nice | WP-13 | open |  |  |
| DAT-01 | Blockers | WP-05 | open |  |  |
| DAT-02 | Blockers | WP-02, WP-08 | done (resolver in WP-02; call sites in WP-08) | 9e050952 | Explicit `candidate_pathway` and `candidate_basis` columns, and one resolver whose `dpaRestricted` replaces the country test (`computeDpaRestricted` in `lib/candidate-pathway.js`: fail closed, regulatory rule unconfirmed, one place to correct). `feeBasisFor` gives the fee tier from the basis. As briefed, WP-02 did NOT rewire the existing country test: the four `gpQualifiesForRole` call sites and AI matching's `dpaEligible` still use `australiaTrained` until WP-08 switches them to `!dpaRestricted` (passing `legacyDpaExempt` so overseas doctors stay identical). |
| DAT-03 | Blockers | WP-03 | done | b84bec3a | Migration `20261120110000_au_gp_wp03_stages.sql` widens `registration_cases_stage_check` and `scheduled_calls_stage_check` from the LIVE lists (file only; applied to the local test database, not to any Supabase project). Stage derivation branches on pathway: an Australian case advances `placement → prestart` when a placement is recorded and onward through `advanceAuCaseStage` (WP-13 calls it for commenced / guarantee / complete). Readers of the stage (intent score index, candidate rail, CEO funnel, stalled-doctor position) tolerate the new values; the Australian funnel and queue views are WP-26 / WP-27. |
| DAT-04 | Blockers | WP-11 | open |  |  |
| DAT-05 | Blockers | WP-09 | open |  |  |
| DAT-06 | Blockers | WP-11 | open |  |  |
| DAT-07 | Required | WP-07 | open |  |  |
| DAT-08 | Required | WP-06 | open |  |  |
| DAT-09 | Required | WP-02, WP-14 | done (rule and helper; copy-forward is WP-14) | 9e050952 | Decided and documented (`CONVENTIONS.md` section 6): `gp_credentials` is the source of truth for a doctor who already holds Ahpra registration, read by every Australian pathway and only that; the overseas grant handler keeps writing `registration_cases.ahpra_registration_*`; `user_profiles.register_*` stays the onboarding identity check. The rule is encoded in one helper, `readAhpraRegistration` (`lib/gp-credentials.js`). No existing data was moved or rewritten. The report's "the grant handler copies into it" is left to WP-14 (optional copy-forward), as briefed. |
| DAT-10 | Required | WP-08 | open |  |  |
| DAT-11 | Required | WP-08 | open |  |  |
| DAT-12 | Required | WP-08 | open |  |  |
| DAT-13 | Required | WP-08 | open |  |  |
| DAT-14 | Required | WP-23 | open |  |  |
| DAT-16 | Required | WP-13 | open |  |  |
| DAT-17 | Required | WP-08 | open |  |  |
| DAT-19 | Required | WP-02, WP-05 | done (admin override; sign-up side is WP-05) | 9e050952 | The admin override `POST /api/admin/seed-onboarding` (super admin, non-production) accepts `country: 'AU'` with an explicit `pathway` when the switch is on, sets and confirms the pathway through `setCandidatePathway`, and refuses Australia without an Australian pathway. Switch off: accepts exactly what it did before. "Set pathway at onboarding" is WP-05, using the WP-02 helper. The second pointer (`['UK','NZ','Ireland']` in the legacy `/api/auth/send-code` OTP sign-up) was checked and deliberately NOT widened: no page calls that endpoint, and admitting "Australia" there would create an Australia-country doctor with no pathway, who would read as overseas and pass today's country-based DPA test. |
| DAT-21 | Should | WP-07 | open |  |  |
| DAT-22 | Should | WP-10 | open |  |  |
| DAT-23 | Should | WP-08 | open |  |  |
| DAT-24 | Should | WP-25 | open |  |  |
| DAT-25 | Should | WP-25 | open |  |  |
| DAT-26 | Should | WP-07 | open |  |  |
| DAT-27 | Should | WP-20 | open |  |  |
| COM-24 | (no row in report) | WP-08 | open |  | Named in a "Closes" line but has no finding row in the report |
| COM-26 | (no row in report) | WP-27 | open |  | Named in a "Closes" line but has no finding row in the report |
| COM-29 | (no row in report) | WP-17 | open |  | Named in a "Closes" line but has no finding row in the report |
| COM-30 | (no row in report) | WP-17 | open |  | Named in a "Closes" line but has no finding row in the report |
| COM-31 | (no row in report) | WP-17 | open |  | Named in a "Closes" line but has no finding row in the report |
| COM-35 | (no row in report) | WP-15 | open |  | Named in a "Closes" line but has no finding row in the report |
| COM-36 | (no row in report) | WP-20 | open |  | Named in a "Closes" line but has no finding row in the report |
| COM-38 | (no row in report) | WP-10 | open |  | Named in a "Closes" line but has no finding row in the report |
| DAT-15 | (no row in report) | WP-23 | open |  | Named in a "Closes" line but has no finding row in the report |
| DAT-20 | (no row in report) | WP-04 | open |  | Named in a "Closes" line but has no finding row in the report |
| DAT-28 | (no row in report) | WP-22 | open |  | Named in a "Closes" line but has no finding row in the report |

## New messages

| ID | Work package | Status | Commit | Builder / trigger / test, or reason if deferred |
| --- | --- | --- | --- | --- |
| N01 | WP-16 | open |  |  |
| N02 | WP-16 | open |  |  |
| N03 | WP-16 | open |  |  |
| N04 | WP-17 | open |  |  |
| N05 | WP-17 | open |  |  |
| N06 | WP-17 | open |  |  |
| N07 | WP-17 | open |  |  |
| N08 | WP-17 | open |  |  |
| N09 | WP-17 | open |  |  |
| N10 | WP-17 | open |  |  |
| N11 | WP-17 | open |  |  |
| N12 | WP-17 | open |  |  |
| N13 | WP-17 | open |  |  |
| N14 | WP-17 | open |  |  |
| N15 | WP-17 | open |  |  |
| N16 | WP-17 | open |  |  |
| N17 | WP-17 | open |  |  |
| N18 | WP-17 | open |  |  |
| N19 | WP-17 | open |  |  |
| N20 | WP-17 | open |  |  |
| N21 | WP-17 | open |  |  |
| N22 | WP-17 | open |  |  |

## Safety packages (no finding ID)

| Package | Status | Commit | Notes |
| --- | --- | --- | --- |
| WP-00S preview send lock | done | 7f099827 | Vercel previews fail closed on Resend, DoubleTick, Gmail API, Google Calendar, DoubleTick account writes, Retell, Meta CAPI and Calendly bookings. Production, localhost and tests unchanged. Rules in `CONVENTIONS.md` section 13; what is still unguarded is listed in `ENVIRONMENT.md` ("What changed since this audit"). Owner action 1 in `OWNER-ACTIONS.md`. |

## Commercial issues (report section "Commercial and legal")

| Issue | Work package | Status | Commit | Notes |
| --- | --- | --- | --- | --- |
| Commercial issue 1 | WP-28 | deferred (legal) | 48c48cb5 | "Based in Australia" is undefined (three phrasings). No wording changed. Marked LR-1 in the draft; question in `agreement-au-variant-legal-review.md`. Owner decision 3: no separate segment B price; consequence flagged. |
| Commercial issue 2 | WP-28 | deferred (legal) | 48c48cb5 | "Most candidates ... hold or be eligible for VR" left as written. Marked LR-2. Owner decision 5: non-VR gated off by default. |
| Commercial issue 3 | WP-28 | n/a (owner decision 4) | 48c48cb5 | Payment timing unchanged: full fee on commencement. Recorded as accepted risk, LR-3. |
| Commercial issue 4 | WP-28 | deferred (legal) | 48c48cb5 | Clause 7.4 unchanged. Marked LR-4. |
| Commercial issue 5 | WP-28, WP-13 | deferred (legal); tracking in WP-13 | 48c48cb5 | Guarantee terms unchanged, LR-5. Tracking is ADM-06 / DAT-16 (WP-13). |
| Commercial issue 6 | WP-28, WP-13 | deferred (legal); tracking in WP-13 | 48c48cb5 | Part-time uplift unchanged, LR-6. Needs numeric sessions (DAT-16). |
| Commercial issue 7 | WP-28 | done (draft only) | 48c48cb5 | Australian-focused cover line and page 2 written as DRAFT variant `au-2026-draft`. Not selectable, no PDF built, source under `docs/au-gp/legal-draft/` (not the publicly served `assets/`). Lawyer review required first. |
| Commercial issue 8 | WP-28 | deferred (owner) | 48c48cb5 | Pre-July-2026 signers unknown. LR-8 and an owner action. |
| Commercial issue 9 | WP-28 | n/a (owner decision 10) | 48c48cb5 | Locum terms carried over unchanged, LR-9. |
