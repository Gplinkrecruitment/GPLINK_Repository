# Australian GP build: scheduled jobs and sweeps

Written by WP-04. Every scheduled job in `vercel.json` (41), plus the staff
buttons and event-driven senders that do the same kind of work, with what each
one does about a doctor on an Australian pathway.

**In one paragraph.** Before this package no scheduled job knew a doctor's
pathway, so a doctor already working in Australia would have been chased about
MyIntealth, had "no GP activity" tasks raised against them while having nothing
to do in the app, and been swept into nudges written for a doctor moving
country. Now each job that could do that loads one list per run (the doctors on
an Australian pathway) and leaves those doctors alone. With the
`AU_PATHWAY_ENABLED` switch off the list is never read and every job behaves
exactly as it does on `main`.

Line numbers are for `server.js` at this package's commit. Treat them as
pointers: search for the job path or the helper name.

## How a job asks

```js
const au = await auSweepPathwayIndex('weekly-sweep');   // once per run
if (au.excludesUser(row.user_id)) continue;             // a doctor-keyed row
if (au.excludesCase(caseRow)) continue;                 // a case row
if (await auSweepExcludesCaseId(au, task.case_id)) continue;   // only a case id in hand
```

| Situation | What the index does |
| --- | --- |
| Switch off | Inert. No query. Every answer is `false`. |
| Switch on | Two small reads of its own. (1) `user_profiles?select=user_id,candidate_pathway&candidate_pathway=in.(au_vr,au_restricted,au_non_vr,au_registrar)`. (2) Since WP-05: `user_state?select=user_id,gp_au_branch_started_at:state->>gp_au_branch_started_at&state->>gp_au_branch_started_at=not.is.null`, the doctors who answered "yes" to the first onboarding question and have not finished (they have no pathway yet). Both lists are treated the same. Nothing is added to a job's existing queries. |
| Migration not applied (the column is missing) | Empty list, one log line, the job carries on. Without the column nobody can be Australian. |
| The read fails for any other reason | `unreadable`: **every** doctor is held for this run (unknown fails closed) and the job tries again on its next run. |

Since WP-05 "a doctor on an Australian pathway" also covers a doctor who is
part-way through the Australian onboarding branch (the server-owned marker
`user_state.state.gp_au_branch_started_at`, set when a saved wizard blob says
`auBranch: 'yes'`, removed when it no longer does and when onboarding
completes). That is what keeps "Add my GMC number" reminders (jobs 17, the
on-demand step follow-up, `sendStalledNudgeForPosition`) away from them.

"Excluded" below always means: with the switch on, a doctor on **any**
Australian pathway (`au_vr`, `au_restricted`, `au_non_vr`, `au_registrar`),
confirmed by staff or self-declared, gets no message and no task from that
job, and nothing about them is stamped or scored. NULL and the two overseas
values are overseas doctors and are never excluded.

Rules and the predicate: `lib/au-sweeps.js`. The read: `auSweepPathwayIndex`
(`server.js:6107`). Conventions: `CONVENTIONS.md` section 15.

## The 41 scheduled jobs

Handling is one of:

- **n/a**: cannot act on a doctor or a case.
- **excluded**: Australian-pathway doctors are left out through the index.
- **gated**: an early return inside the function the job calls.
- **lead layer**: acts on leads (`site_enquiries`), not on doctors with a
  pathway; handled by WP-01's lead rules.
- **neutral**: left as it is, with the reason.

| # | Job | Schedule (UTC) | What it targets | Handling for an Australian-pathway doctor | Where | Test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `process-gmail` | every 15 min | Inbound mail in the staff mailboxes | **gated**. Inbound mail is filed on the case as before. The one overseas-only action, the "registration granted" flow (opens a visa case, creates migration-agent and passport tasks), does nothing for an Australian doctor; the email then falls through to the ordinary AHPRA correspondence card for staff, so it is never lost. | `handleAhpraRegistrationGranted` `server.js:24615` | `au-wp04-sweeps-server` "registration granted flow does nothing" (the handler is tested directly: the job needs a live Gmail mailbox) |
| 2 | `renew-gmail-watch` | daily 06:00 | Gmail push subscriptions | **n/a** | `:51657` | |
| 3 | `reconcile-followups` | daily 20:00 | Staff follow-up tasks that are due; an AI check closes or escalates them | **neutral**. Works on tasks staff created, by due date. Not keyed on the doctor's activity and words nothing itself. | `:51929` | read |
| 4 | `reconcile-doc-tasks` | hourly :30 | (a) cases whose practice documents are complete, (b) qualification documents under review with no review task, (c) undelivered Section G | **Australian behaviour (WP-07)** for (b): an Australian doctor's own document (`au_reg`, key `au_*`) that is waiting for a person with no open task gets a `doc_review` task under its Australian stage (`ensureAuDocReviewTask`); their overseas-keyed rows are still left out, and no "flagged qualification" task is raised for them. **excluded** for (c); **gated** for (a) inside `_maybeNotifyAhpraDocsReady` ("your AHPRA step is unlocked" is never sent). | `:51839`, `sweepUndeliveredSectionG` `:25181`, `_maybeNotifyAhpraDocsReady` `:27857` | matrix "reconcile-doc-tasks", "AHPRA documents ready notifier", "two quiet jobs" |
| 5 | `interview-reminders` | hourly | Interviews tomorrow: doctor, practice, staff | **neutral**. An interview is an interview on either pathway; the copy names no registration step. | `:52075` | read |
| 6 | `weekly-sweep` | daily 22:00 | (a) cases at `myintealth` / `amc` quiet 14 days, (b) tasks 3+ days overdue, (c) documents about to expire | **excluded** for (a), including a doctor whose case is still parked at `myintealth`. (b) and (c) are **neutral**: they key on a task's due date and a document's expiry date, not on the doctor's activity. | `:54866` | matrix "weekly-sweep", "mixed run", "weekly sweep, spelled out" |
| 7 | `weekly-backup` | Sunday 03:00 | Database export to Drive | **n/a** | `:55403` | |
| 8 | `call-summary-retry` | daily 00:00 | Zoom call summaries that failed to save | **neutral**. Staff record only. | `:55637` | read |
| 9 | `call-reminders` | every 5 min | Booked consult and assistance calls: reminders to the lead, the doctor and the RSO | **neutral** for booked assistance calls (an Australian doctor's call is booked by staff about `prestart`). The lead-facing consult reminders are **lead layer** (held by `auMessagesHeld`, WP-01). The RSO's own reminder shows the raw stage key for an Australian call: wording, WP-26. | `:55935` | `au-wp01-lead-hold-endpoints` |
| 10 | `detect-no-shows` | every 10 min | Finished calls and interviews | **neutral**. Completes interviews and asks the practice for a decision; no registration wording. The lead no-show rescue is lead layer (WP-01). | `:55662` | read |
| 11 | `purge-accounts` | daily 04:00 | Accounts past the deletion window | **neutral**. A privacy rule that applies to everyone. | `:56985` | read |
| 12 | `purge-identity-docs` | daily 04:00 | Stored ID documents: 6 months after placement or 12 months of inactivity | **neutral**, flagged. It is keyed on inactivity, but as a 12-month privacy retention rule, not a chase. Whether an Australian doctor's ID document should be kept through the guarantee period is a privacy decision: WP-25. | `:57086` | read |
| 13 | `purge-practices` | daily 04:15 | Practices past retention | **n/a** | `:57027` | |
| 14 | `check-model-updates` | Monday 05:00 | New AI model notice | **n/a** (a company-level task with no case) | `:51695` | |
| 15 | `recompute-intent` | daily 02:00 | The ATS "intent" score for up to 300 open cases | **scored on the Australian model (WP-08)**. Registration counts when staff have verified the doctor on the Ahpra register (not an overseas stage), the documents share is CV, cover letter and ID (no degree), and "recently active" runs on a four-times-longer clock (`lib/ats-intent.js`, `pathwayModel: 'au'`). **Held** (stored score left alone): the whole run when the pathways cannot be read; one doctor whose pathway could not be read; a case that says Australian by itself while its doctor did not read as Australian. Switch off: every case is the overseas model, nothing extra read. | search `'/api/cron/recompute-intent'` | "the nightly intent score: an Australian case is scored on the Australian model" |
| 16 | `organize-drive` | daily 03:00 | Google Drive folders for cases | **neutral**. Staff filing; nothing is sent. | `:51633` | read |
| 17 | `onboarding-nudge` | hourly | Doctors who have not finished onboarding | **excluded**. No email, no WhatsApp, and no reminder row is started for them. | `:53553` | matrix "onboarding-nudge" |
| 18 | `consult-nudge` | every 5 min | Leads | **lead layer**. Emails and WhatsApps to an Australian-segment lead are held by `auMessagesHeld` (switch on); the owner is still paged. Unchanged by WP-04. | `:54297` | `au-wp01-lead-hold-endpoints` |
| 19 | `lead-calls` | every 5 min | Leads Hazel may ring | **lead layer**. Hazel never rings an Australian-segment lead, **switch on or off** (changed by WP-04, see below). | `lib/lead-calls.js` `leadCallDecision`; `placeLeadCall` `server.js:35625` | `au-wp01-lead-hold-*`, `lead-calls-lib`, `ceo-leads-endpoint` |
| 20 | `zoho-reengage` | weekdays 10:00 | Imported Zoho candidates with a UK mobile | **neutral**. UK mobiles only, by design (`lib/zoho-reengage.js` `ukMobileE164`); these are old imported contacts, not app doctors. | `:54274` | read |
| 21 | `zoho-whatsapp-auto` | every 15 min | Imported Zoho leads with a UK mobile | **neutral**. Same UK-mobile rule; registered doctors are stopped first. | `:54178` | read |
| 22 | `meta-lead-stages` | hourly :50 | Leads, reported to Meta as funnel stages | **neutral**, flagged. Sends nothing to a doctor. An Australian lead still feeds the UK campaign's "qualified GP" signal: WP-24 (segment in the Meta feed). Not changed here because the same feed is also called from the event paths, and gating only the scheduled half would give Meta an inconsistent picture. | `:54028` | not changed |
| 23 | `match-lifecycle` | hourly | Matches about to expire | **neutral**. Role reminders and expiry are the same on both pathways (report: M01 to M26 are fine). Quiet hours for the final call: WP-16. | `:54669` | read |
| 24 | `sla-sweep` | daily 20:30 | (a) cases 5 days without GP activity, (b) a snapshot of the stuck-case buckets | **excluded** for both. No "no GP activity" task on an Australian case (so it adds nothing to an RSO's open-task count), and Australian cases are left out of the buckets and counted in `au_excluded`. **Since WP-06 it also runs (c) the yearly Ahpra re-check** (`runAuAhpraRecheckSweep`, switch on only; see "The yearly Ahpra re-check" below). **Since WP-11 it also runs (d) the pre-start pass** (`runAuPrestartSweep`, switch on only; see "The pre-start pass" below). **Since WP-13 (c) and (d) are run by one call, `runAuLifecycleSweep`, which then does (e) the Australian lifecycle reminders** (see "The Australian lifecycle job" below). | `runSlaCheck` `:27446`, `computeStuckCaseBuckets` `:27501`, `runAuLifecycleSweep` (which calls `runAuAhpraRecheckSweep` and `runAuPrestartSweep`) | "SLA check", "stuck cases", matrix "sla-sweep"; `au-wp06-staff-tools-server` "the yearly re-check"; `au-wp13-server` "the daily lifecycle job" |
| 25 | `stalled-applications` | daily 21:20 | Introduced applications with no movement for 60 days: an owner email | **neutral**. Owner-facing, no registration wording, and still true for an Australian doctor. 60 days is too slow for them: WP-27 sets the threshold. | `runStalledApplicationSweep` | switch-off run only |
| 26 | `chase-nonresponders` | daily 21:00 | (A) practices holding an SPPA-00, (B) AHPRA officers who have not replied, (C) cases quiet 14 days at career / ahpra / visa / pbs | **excluded** for all three. | `:55200` | matrix "chase-nonresponders", "spelled out" |
| 27 | `practice-decision-reminders` | daily 21:50 | Practices who have not answered about a candidate | **neutral**. Practice-facing, about a decision (report: P05 fine). Weekend skip (WP-10, COM-27): switch on, judged per practice on that practice's own clock, for every candidate's practice; switch off, the UTC day as before. CONVENTIONS section 2. | `:55062` | read |
| 28 | `owner-digest` | Sunday 21:00 | A weekly summary for the owner | **neutral**. Owner-facing totals. An Australian block in it: WP-27. | `:52428` | read |
| 29 | `error-digest` | daily 21:40 | Server errors | **n/a** | `:52446` | |
| 30 | `error-fix-analysis` | daily 21:10 | Server errors | **n/a** | `:52467` | |
| 31 | `error-fix-execute` | hourly :25 | Server errors | **n/a** | `:52493` | |
| 32 | `refresh-summaries` | hourly | AI case summaries that are out of date | **excluded**. The prompt assumes an overseas journey, so no summary is generated for an Australian case (and they do not use up the per-run cap). | `:75194` | "refresh-summaries" (the predicate, directly: the job needs an AI key) |
| 33 | `sppa-backfill-scan` | every 15 min | SPPA-00 tasks not yet scanned | **excluded**. | `:51264` | "two quiet jobs" |
| 34 | `social-publish` | hourly :05 | Social posts | **n/a** | `:52835` | |
| 35 | `social-campaign-open` | monthly | Social campaign | **n/a** | `:52849` | |
| 36 | `register-auto-verify` | hourly :40 | Pending public-register checks | **excluded**. The automatic sources are the UK and NZ registers, and a "before the cutoff" answer sends a doctor to the overseas PEP waitlist. | `:51212` | "two quiet jobs", matrix |
| 37 | `performers-mirror-sync` | daily 05:10 | A copy of the NHS performers list | **n/a** | `:51182` | |
| 38 | `dropoff-nudge` | hourly :40 | Doctors who finished onboarding and then went quiet | **excluded**. | `:53722` | matrix "dropoff-nudge" |
| 39 | `doc-ai-review` | every 10 min | Newly uploaded qualification documents, and (WP-07) an Australian doctor's documents | **Australian behaviour (WP-07).** A row under `au_reg` with an Australian key is decided by the Australian rules (`runAuDocumentAiReview`, `lib/au-document-review.js`) for a doctor on an Australian pathway; every other qualification row by the existing rules, and still never for an Australian doctor. Routing: `auDocumentReview.reviewRulesFor`. A model outage rejects nothing (the document stays under review with a task). The reply adds `au_reviewed` when any were. | `:53826` | matrix "doc-ai-review" |
| 40 | `ads-daily-review` | daily 21:30 | Meta ads | **n/a** | `:53496` | |
| 41 | `ads-launch` | every 15 min | Meta ads | **n/a** | `:53508` | |

**Totals:** 12 n/a, 11 excluded through the index, 1 gated (`process-gmail`),
2 lead layer (`consult-nudge`, `lead-calls`), 15 left neutral.

Tests named "matrix" are in `tests/au-wp04-sweeps-server.test.js`: each job is
run against 21 doctors (three Australian pathways, each at `placement`,
`prestart`, `commenced`, `guarantee`, `complete`, parked at `myintealth`, and
part-way through onboarding) and must open no task and send nothing. "read"
means checked by reading the handler, not by a test.

## The same work outside the schedule

| What | Handling | Where | Test |
| --- | --- | --- | --- |
| The manual weekly check-in (`POST /api/admin/va/weekly-checkin/sweep`) | **excluded**, same rule as job 6 | `:79235` | matrix "the manual weekly check-in" |
| Stuck cases tab (`GET /api/admin/stuck-cases`) | Australian cases left out of the buckets, same function as job 24 | `:27501` | "stuck cases" |
| On-demand onboarding follow-up (`/api/cron/onboarding-step-followup`, not on the schedule) | **excluded**, even when a doctor is named in `?only=` | `:53669` | matrix |
| `chaseStalledCase` (shared by jobs 6, 26 and the manual sweep) | Last guard: a doctor on the Australian ladder gets no "GP stalled" task and no nudge, whoever calls it | `:44204` | matrix "the stalled-GP chase itself" |
| `sendStalledNudgeForPosition` | No stage reminder **and** no overseas onboarding step email for the Australian ladder (WP-03 covered only the stage reminder) | `:44177` | same |
| Stage messages in `processRegistrationTaskAutomation` (COM-09) | For an Australian doctor a state flag never sends the MyIntealth welcome WhatsApp (this is the "page-open WhatsApp"), the AMC, Career, AHPRA or Visa stage WhatsApp and email, and never opens a "Verify AHPRA ..." task | `:26893` to `:27163` | matrix "the stage messages", "career secured" |
| `_maybeNotifyAhpraDocsReady` (COM-09), all four callers | Early return | `:27857` | matrix, "two quiet jobs" |
| Visa bell item (`pushVisaNotificationToOwner`) | Never written for an Australian pathway | `:40833` | "the visa bell item" |
| `handleAhpraRegistrationGranted`, email or manual | Does nothing and says why | `:24615` | "registration granted flow" |

Bell and push, checked: the only bell or push items that name a visa or AHPRA
step come from `pushVisaNotificationToOwner` (gated above),
`handleAhpraRegistrationGranted` (gated above) and the staff stage setter
`applyVerifiedStageToGp` (already refused for an Australian doctor by WP-03).
Provider-number (`pushPbsNotificationToOwner`), career and document items are
correct for an Australian doctor and are untouched. Stage items drawn by the
browser from the doctor's own state (`js/updates-sync.js`) are client work:
WP-12.

## Ageing an Australian case (ADM-04)

An Australian doctor has nothing to do in the app between milestones, so "the
GP has been quiet for N days" says nothing about their case. This package does
the minimal correct thing:

- Australian cases are **out of every sweep that keys on GP inactivity**: the
  14-day chase (jobs 6, 26, the manual sweep), the 5-day SLA task (job 24), the
  stuck-case buckets, and the nightly intent score (job 15). Nothing writes a
  blocker status, an escalation or a "Cold" band onto an Australian case
  because of inactivity. (The overdue-task escalation in job 6 is unchanged for
  everyone: it keys on a task's due date.)
- `auSweeps.auCaseAgeAnchor(caseRow, placementRow)` (`lib/au-sweeps.js`) returns
  the date an Australian case is aged from: case creation at `placement`, the
  placement record at `prestart`, the start date at `commenced` and
  `guarantee`, completion at `complete`. It never reads `last_gp_activity_at`.
  `auCaseAgeDays` gives whole days. **WP-13's lifecycle job calls it** (how long
  a provider number has been pending since the placement).

**Hook for WP-13:** the daily Australian lifecycle job (COM-40: provider number
pending, indemnity expiry, notice countdown, guarantee check-ins, Ahpra
renewal) ages cases with `auCaseAgeAnchor` and passes its own commencement and
guarantee columns as `commenced_at` / `guarantee_started_at` on either row.

## Hooks left for later packages

Each is one `excludes…` call (or one early return) to replace with the real
Australian behaviour.

| Package | What it completes | The call to replace |
| --- | --- | --- |
| WP-06 | **Done.** Ahpra check for an Australian doctor in place of the UK / NZ register lookup | Ahpra rows are now left out of `register-auto-verify` at the source (see "Ahpra rows and `register-auto-verify`" below), so the crowding limit is gone for them. `ravAu.excludesUser` stays as a second guard for an Australian-pathway doctor whose row names another register. |
| WP-07 | Australian document rules | **Done.** Both hooks replaced (see rows 4 and 39). Known limit kept: the job reads the 60 oldest undecided documents before filtering, and a row it does not decide is not stamped, so an Australian doctor's stray overseas-keyed rows (or an overseas doctor's stray `au_reg` rows) still occupy a place in that batch. The "Review uploaded: ..." task under stage `ahpra` is no longer created for a doctor on an Australian pathway. |
| WP-08 | An intent model for Australian doctors | **Done.** The exclusion is replaced by real scoring (row 15). `atsProdCandidateFacts` sets `facts.auIntent` (`auIntentFactsFor`), so the on-demand recompute, the candidate drawer and the withdraw path use the same model. One known limit: an on-demand recompute for a doctor whose pathway cannot be read at that moment scores on the overseas model (the nightly job holds instead). The three-strike careers lock (`evaluateCareerLocks`, called by `match-lifecycle`) reads its threshold from `lib/application-caps.js`; with the default (3 for every pathway) it reads nothing extra. |
| WP-10 | Weekend skip in the practice's time zone (COM-27) | **done in WP-10** (`auTimezone.practiceWeekendNow`, both passes of `practice-decision-reminders`, switch on only) |
| WP-11 | The placement cascade | **Done in WP-11.** The "Career secured" block of `processRegistrationTaskAutomation` and steps 5 and 8 of `finalizeInAppPlacement` now ask `placementHooksFor` (`lib/placement-hooks.js`): no SPPA-00 / Section G / supervisor CV / position description task and no practice-pack email for a doctor on an Australian pathway. The three exclusions that existed to cope with those tasks (`sweepUndeliveredSectionG(limit, auIndex)`, `sbAu` in `sppa-backfill-scan`, pass A of `chase-nonresponders`) stay as a second guard. New daily work: `runAuPrestartSweep` at the end of `sla-sweep` (see "The pre-start pass" below). |
| WP-13 | Australian lifecycle reminders, aged from milestones (COM-40) | **Done in WP-13** (see "The Australian lifecycle job" below): `runAuLifecycleSweep` ages cases with `auCaseAgeDays`. **Not done, left for WP-26 / WP-27:** an Australian view of stuck cases in place of `au_excluded` (`computeStuckCaseBuckets`); Australian cases are still simply left out of those buckets. |
| WP-14 | Segment B: AHPRA mail, visa transfer | `grantAuMode` in `handleAhpraRegistrationGranted` `:24615`, pass B of `chase-nonresponders`, the visa bell gate `:40833`. All three currently treat every Australian pathway alike. |
| WP-16 | Quiet hours on elapsed-time sends (COM-22); Australian lead copy | the nudge senders; `auMessagesHeld` call sites |
| WP-17 | Australian onboarding and drop-off nudges | `onbAu` `:53553`, `osfAu` `:53669`, `dnAu` `:53722`, and the Australian branch of `sendStalledNudgeForPosition` `:44177` |
| WP-20 | AI summary prompt for an Australian case | `rsAu` in `refresh-summaries` `:75194`. The staff "refresh summary" button is not gated. |
| WP-24 | Segment in the Meta lead-stage feed | `meta-lead-stages`, untouched here |
| WP-25 | Whether ID documents are kept through the guarantee period | `purge-identity-docs`, untouched here |
| WP-26 | Stage labels in staff reminders; forwarding `au_excluded` to the Stuck cases tab | `call-reminders`; `GET /api/admin/stuck-cases` |
| WP-27 | Gone-quiet threshold for Australian applications; an Australian block in the owner digest | `stalled-applications`, `owner-digest`, untouched here |

## Ahpra rows and `register-auto-verify` (WP-06: COM-11, DAT-08)

There is no automatic source for the Ahpra register (it blocks automated
traffic, and scraping it is out of scope by decision). Before WP-06 the hourly
job still "attempted" a pending Ahpra row: it stamped
`register_auto_checked_at`, answered "manual only", and came back to the same
row every seven days for ever.

With the switch on an Ahpra row is staff-check only:

- the job's read leaves Ahpra rows out
  (`or=(register_body.is.null,register_body.neq.ahpra)`, an existing column) and
  the batch filters them again in memory, for a doctor with or without a
  pathway recorded;
- `attemptAutomaticRegisterVerification` returns
  `{ outcome: 'manual_only', staffCheckOnly: true }` for an Ahpra row before
  reading or stamping anything, whoever calls it (this job, the wizard
  precheck, the drawer's Auto-check button, a staff number change).

With the switch off both are exactly as on `main`.

## The yearly Ahpra re-check (WP-06: DAT-08)

No new cron. `runAuAhpraRecheckSweep()` is called once a day at the end of
job 24 (`sla-sweep`, 20:30 UTC; since WP-13 through `runAuLifecycleSweep`), switch on only; its result is the
`au_ahpra_recheck` key of that job's response.

- It reads `gp_credentials` rows that staff have checked at least once
  (`ahpra_last_checked_at` not null, oldest first, up to 500).
- `auStaffTools.ahpraRecheckDue(row, now)` decides: last checked more than 12
  months ago, or the registration expires within 60 days (one reminder when
  that window opens, one more once the date has passed).
- For each doctor who is due and on an Australian pathway it opens an
  `ahpra_register_check` task (`auRaiseAhpraCheckTask`): due in 14 days, high
  priority for an expiry. One open check task per doctor, so tomorrow's run
  opens nothing new. Saving the check stamps `ahpra_last_checked_at`, which
  clears it for a year.
- Nothing is sent to the doctor.

**Done in WP-13:** the lifecycle job (`runAuLifecycleSweep`) now makes this call
and the separate call in the `sla-sweep` handler is gone. The result is still
the `au_ahpra_recheck` key of that job's response.

## The pre-start pass (WP-11)

No new cron. `runAuPrestartSweep()` is called once a day at the end of job 24
(`sla-sweep`, 20:30 UTC; since WP-13 through `runAuLifecycleSweep`), switch on only; its result is the `au_prestart` key
of that job's response (`{ ok, cases, released, finished, reminded }`). With
the switch off it reads nothing.

- **Held placements.** A placement recorded while the doctor's pathway could
  not be read is held (`user_state.state.gp_au_placement_hold`, plus a staff
  task). The pass re-reads the pathway for up to 50 held doctors and, once it
  reads, runs the right steps: today's overseas cascade, or the Australian
  one. The same release also runs at the top of every
  `processRegistrationTaskAutomation` pass, so most holds clear before the
  daily job sees them.
- **Unfinished placements.** An Australian case at `prestart` whose placement
  has no "Australian placement steps completed" marker gets its steps run
  (`auRunPlacementHooks`). Every step claims a once-ever key first, so this
  never sends a second message or opens a second task.
- **Tasks kept in step.** Indemnity approved closes its task; the
  credentialing-pack task is raised when its trigger is met.
- **N13 reminders.** A doctor whose required pre-start documents are still
  missing is reminded once at 3 days and once at 7 days after the placement
  (email and bell; no WhatsApp). Once-ever keys per placement and day mark.
  Quiet hours are not applied yet (the job runs at 20:30 UTC, early morning
  in Australia): **WP-16** owns quiet hours on elapsed-time sends.

**Done in WP-13:** the lifecycle job (`runAuLifecycleSweep`) now makes this call
and the separate call in the `sla-sweep` handler is gone. The result is still
the `au_prestart` key of that job's response.

## The Australian lifecycle job (WP-13: COM-40)

No new cron, and `vercel.json` is unchanged. One function,
`runAuLifecycleSweep(nowMs)` (`server.js`; the work is in
`lib/au-commencement.js`, the rules in `lib/au-lifecycle.js`), is called once a
day at the end of job 24 (`sla-sweep`, 20:30 UTC), switch on only. It is now
the **only** Australian call that job makes: it runs the yearly Ahpra re-check
(above) and the pre-start pass (above) itself, and their results keep the
response keys they always had (`au_ahpra_recheck`, `au_prestart`). Its own
result is the `au_lifecycle` key: `{ ok, at, prestart_cases,
commenced_placements, fired: [{ kind, user_id, to, channel, ... }] }`. With the
switch off the job's response has none of the three keys and nothing is read.

**What moved:** the two calls `runAuAhpraRecheckSweep(...)` and
`runAuPrestartSweep(...)` were in the `sla-sweep` handler; they are now made
inside `runAuLifecycleSweep`. Neither function changed.

**Who it looks at.** (1) Active cases at `prestart` whose doctor is on an
Australian pathway, with an active placement that has not commenced. (2)
Active `placements` rows with a commencement date (`commenced_at` not null: a
WP-13 column, so this read is switch-on only and a database without the
migration answers 400, which just means nobody has commenced), again only when
the doctor reads as Australian. An overseas doctor's placement is skipped at
the pathway check, before anything else about it is read
(`skipped_not_au` counts them).

**Each reminder happens once, even when two runs of the job overlap or the
job overlaps a person** (CONVENTIONS section 25, "The idempotency rule"). A
reminder **task** is unique in the database: the partial unique index
`uniq_au_lifecycle_task` (one task per case, placement, kind and mark) refuses
a second one, and the job treats that as "already raised". A reminder
**message** has one owning run, which claims `au_lc:<kind>:<placement
key>[:<mark>]` in the once-ever ledger (`gp_nudge_log`, channel `lifecycle`)
before sending and hands the claim back if the doctor's email did not go; each
part of a message also has its own ledger key. The job also **repairs**: a
commencement whose five tasks are not all there (the request died half-way) is
completed on the next run (`derived_tasks_repaired` in the result). A day is the **practice's**
calendar day (its state's time zone; Sydney when unknown). An Australian case
is aged with `auCaseAgeDays` (from the placement milestone, never from the
doctor's activity in the app: ADM-04).

| Trigger | Who | Channel |
| --- | --- | --- |
| Registration last checked more than 12 months ago, or expiring within 60 days (WP-06's rule) | staff (consultant / CEO) | `ahpra_register_check` task |
| A held placement can now be read; a placement's steps did not finish; required pre-start documents still missing 3 and 7 days after placement (WP-11's pass, N13) | staff; the doctor | tasks; email and bell |
| Provider number for the new location still not recorded 14 days after the placement | RSO | the open provider-number task is raised to high priority, with a timeline line |
| Indemnity expiry on file is before the start date, or within 30 days (before the start and through the guarantee period) | RSO | `manual` task |
| No notice recorded and the start date is within the notice period plus a week (28 days when no notice period is on file) | consultant | `manual` task |
| Start date within 14 days, then within 3 days, and the pre-start checklist is not finished | RSO | `manual` task (high, then urgent) |
| **Start date reached and commencement not confirmed** (checklist row 12's trigger) | consultant | `manual` task "Confirm commenced: ...". Closes by itself when commencement is confirmed |
| 7 days after commencement | the doctor and the practice; the case | **N18**: doctor email and bell, practice email (WhatsApp only through an approved Australian template: none is, so skipped and logged). The case moves `commenced → guarantee`. The consultant's first-week task was raised at commencement |
| Weeks 4, 8 and 12 after commencement | the doctor and the practice | **N19**: doctor email and bell, practice email. The three consultant `guarantee_checkin` tasks were raised, dated, at commencement |
| 14 days before the guarantee period ends | consultant | `manual` task |
| The day after the guarantee period ends, doctor still in place | the case; the doctor | case → `complete`; **N20**: doctor email and bell (a thank-you and a referral ask) |
| Invoice recorded as sent and not paid 7 days after its date | CEO | `manual` task. Closes when the invoice is marked paid |
| **Months 6 and 12 after commencement, part-time placements only** (commercial issue 6) | CEO | `manual` task: ask the practice how many sessions the doctor now works; names clause 6.12 and states no amount |

Not sent, on purpose: nothing to a doctor whose placement has ended (an early
exit cancels the remaining check-ins and the job skips the placement); nothing
commercial to a doctor, ever; a message long after its moment (N18 more than
14 days late, a check-in once the next one is due, N20 more than 30 days
late): the staff tasks still exist.

Not applied yet: quiet hours. The job runs at 20:30 UTC, which is 06:30 to
07:30 in the eastern states and 04:30 in Perth. **WP-16** owns quiet hours on
elapsed-time sends; the place to gate is `runLifecycleSweep` in
`lib/au-commencement.js`, before the two `send…Messages` calls.

Tests: `tests/au-wp13-lifecycle-lib.test.js` (the calendar, day by day) and
`tests/au-wp13-server.test.js` ("the daily lifecycle job, walked with a pinned
clock": one placement from pre-start to month 12, each reminder once; overseas
doctors get none; switch off does nothing).

## Send-time gaps (not built here)

The report's "send-time gaps" paragraph belongs to later packages and is still
assigned in `coverage.md`: COM-22 (quiet hours, 08:00 to 20:00 local) to WP-16,
and COM-27 (the practice-reminder weekend skip uses the UTC day) to WP-10.

## Hazel and the switch (the lead's extra item)

Job 19 is the one place this package changed behaviour with the switch **off**.
WP-01 put the Hazel block behind `AU_PATHWAY_ENABLED`, so in production the
only thing stopping Hazel ringing an Australian lead with the script for
doctors moving country was that no Australian from-number is configured. The
block no longer looks at the switch: `auHazelBlocked`, `leadCallDecision`
(including a lead with no country that would be dialled as Australian),
`placeLeadCall` and `ceoLeadCallNow` refuse an Australian-segment lead in both
states with reason `au_segment`. New Zealand leads share the Australian
from-number and are not affected. The hold on emails and WhatsApps
(`auMessagesHeld`) still follows the switch. Recorded as a deliberate
exception in `CONVENTIONS.md` section 2.

One thing a person can see change in production today: on the Leads tab, an
Australian lead now reads "Australian GP: Hazel does not ring Australian leads"
and the "ring now" button answers the same, where before it answered that the
Australian number was not set up. No call was placed either way.

## Time zones in scheduled sends (WP-10)

No send **time** moved in WP-10 except the weekend skip above. What changed is
the local time a message states, for Australian-segment leads and doctors on
an Australian pathway, switch on (CONVENTIONS section 22):

| Job | Change |
| --- | --- |
| `call-reminders` (consult track) | The slot is rendered on the lead's own clock: the zone they booked in (`scheduled_calls.timezone`), then their browser's, then their state. "10:00 am (Perth time)". Overseas leads unchanged. |
| `consult-nudge` (no-show rescue email) | Same zone for the missed slot. |
| `interview-reminders` | A doctor on an Australian pathway is told the time in the device zone they booked with, else their profile zone, else their state. A booking with no device zone used to print the server's time; it now prints the doctor's. Practice and staff copies unchanged. |
| `practice-decision-reminders` | The weekend skip (above). |
| `lead-calls` | Nothing: Hazel never rings an Australian-segment lead. The window function is correct by state for anything that reads it. |

**For WP-16 (quiet hours):** `auTimezone.localHourFor(lead, Date.now())` returns
`{ hour, minute, weekday, zone, source, certain }` for a lead (and for a doctor
with `{ isAu: true }`). The gate itself is not built here.
